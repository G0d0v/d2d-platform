import Fastify, { type FastifyRequest, type FastifyReply, type HTTPMethods } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database, SQL } from './db.ts';
import { migrate } from './db.ts';
import { authenticate, createUser, human, newSession, publicUser, verifyLogin } from './auth.ts';
import { admin, currentWork, event, listProjects, lockProject, member, ownedWork, type Actor } from './model.ts';
import { canonical, digest, equal, id, passwordHash, Problem, token } from './security.ts';
import { choice, errorSchema, generation, integer, object, responseSchemaFor, text } from './contracts.ts';

export interface AppOptions { db: Database; origin?: string; devOrigin?: string; registration?: 'open' | 'invite'; logger?: boolean; staticRoot?: string; }
type RequestData = { Body: Record<string, any>; Params: { id: string }; Querystring: { page?: string } };
type ApiRequest = FastifyRequest<RequestData>;
type Handler = (tx: SQL, actor: Actor, req: ApiRequest, reply: FastifyReply) => Promise<any>;
export async function createApp(options: AppOptions) {
  const { db } = options;
  const origin = options.origin ?? 'http://127.0.0.1:19090';
  const registration = options.registration ?? 'invite';
  const secure = origin.startsWith('https:');
  await migrate(db);
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 65536, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: {
    title: 'D2D API', version: '0.1.0', description: 'Локальная альфа. Мутации требуют Idempotency-Key, кроме входа, регистрации, восстановления, выхода и одноразовой выдачи приглашения/токена агента. Cookie-аутентификация требует X-CSRF-Token из /me. Время — UTC epoch milliseconds. Git/PR/деплой отключены.' },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, session: { type: 'apiKey', in: 'cookie', name: 'd2d_session' } } } } });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin &&
      ![origin, options.devOrigin].includes(req.headers.origin)) throw new Problem(403, 'ORIGIN_REJECTED', 'Запрос с другого сайта запрещён');
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    const status = e instanceof Problem ? e.status : e.validation ? 422 : e.code === '23505' ? 409 : [400, 413, 415, 429].includes(e.statusCode) ? e.statusCode : 500;
    const code = e instanceof Problem ? e.code : e.validation ? 'VALIDATION_ERROR' : status === 429 ? 'RATE_LIMITED' : status === 409 ? 'ALREADY_EXISTS' : status === 413 ? 'BODY_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = e instanceof Problem ? e.message : e.validation ? 'Проверьте поля запроса' : status === 429 ? 'Слишком много запросов. Повторите позже' : status === 409 ? 'Такая запись уже существует' : status === 413 ? 'Запрос превышает 64 КиБ' : status === 415 ? 'Используйте Content-Type: application/json' : status === 400 ? 'Некорректный запрос' : 'Внутренняя ошибка. Сохраните ID обращения';
    if (status === 500) req.log.error(e);
    reply.status(status).send({ error: { code, message, details: e instanceof Problem ? e.details : undefined, retryable: status === 429, request_id: req.id } });
  });

  function route(method: HTTPMethods, path: string, summary: string, body: any, handler: Handler, settings: { public?: boolean; idempotent?: boolean; authRate?: boolean } = {}) {
    const mutation = !['GET', 'HEAD'].includes(method);
    const idem = mutation && settings.idempotent !== false;
    app.route<RequestData>({ method, url: `/api/v1${path}`, config: settings.authRate ? { rateLimit: { max: 10, timeWindow: '1 minute' } } : {},
      schema: { summary, tags: [path.split('/')[1]], security: settings.public ? [] : [{ bearer: [] }, { session: [] }],
        ...(body ? { body } : {}),
        ...(path.includes(':id') ? { params: object({ id: text(80) }) } : {}),
        ...(method === 'GET' && (path === '/projects' || path.endsWith('/tasks') || path.endsWith('/audit-events')) ? { querystring: object({ page: { type: 'string', pattern: '^[1-9][0-9]{0,5}$', default: '1' } }, []) } : {}),
        ...(idem ? { headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': text(150, 8), ...(method === 'PATCH' ? { 'if-match': text(30) } : {}) } } } : {}),
        response: { '200': responseSchemaFor(method, path), default: errorSchema } },
      handler: async (req, reply) => db.transaction(async tx => {
        // Authentication is inside the same lock as mutation so revocation cannot race admission.
        if (mutation) await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');
        const actor = settings.public ? {} as Actor : await authenticate(tx, req, mutation);
        if (!idem) return handler(tx, actor, req, reply);
        const key = String(req.headers['idempotency-key']);
        const fingerprint = digest(canonical({ method, path: req.url, body: req.body ?? null, ifMatch: req.headers['if-match'] ?? null }));
        const old = (await tx.query('SELECT * FROM idempotency WHERE actor_id=$1 AND key=$2', [actor.id, key])).rows[0];
        if (old) {
          // A replay has no side effects, but must not reveal a project after membership/role revocation.
          if (path.startsWith('/projects/:id')) {
            if (path.endsWith('/members')) await admin(tx, actor, req.params.id);
            else await member(tx, actor, req.params.id, true);
          } else if (path.startsWith('/work-sessions/:id')) {
            const w = await sessionProject(tx, actor, req.params.id); await member(tx, actor, w.project_id, true);
          } else if (path === '/tasks/:id') {
            const task = (await tx.query('SELECT project_id FROM tasks WHERE id=$1', [req.params.id])).rows[0];
            if (!task) throw new Problem(404, 'NOT_FOUND', 'Задача не найдена');
            await member(tx, actor, task.project_id, true);
          } else if (path === '/agents/:id/revoke') {
            const agent = (await tx.query('SELECT project_id FROM agents WHERE id=$1', [req.params.id])).rows[0];
            if (!agent) throw new Problem(404, 'NOT_FOUND', 'Агент не найден');
            await admin(tx, actor, agent.project_id);
          } else if (path === '/projects') {
            human(actor); await member(tx, actor, old.response.project.id, true);
          }
          if (old.fingerprint !== fingerprint) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Этот ключ уже использован для другого запроса');
          return old.response;
        }
        await tx.query('INSERT INTO idempotency VALUES ($1,$2,$3,NULL,$4)', [actor.id, key, fingerprint, Date.now()]);
        const result = await handler(tx, actor, req, reply);
        await tx.query('UPDATE idempotency SET response=$1 WHERE actor_id=$2 AND key=$3', [JSON.stringify(result), actor.id, key]);
        return result;
      }),
    });
  }
  const p = (r: ApiRequest) => r.params.id;
  const page = (r: ApiRequest) => Math.max(1, Math.min(1000000, Math.floor(Number(r.query?.page) || 1)));
  const paginate = (data: any[], n: number) => ({ data: data.slice((n - 1) * 50, n * 50), pagination: { page: n, page_size: 50, total: data.length } });
  route('GET', '/status', 'Параметры входа', null, async tx => ({ registration, setup: (await tx.query('SELECT count(*)::int AS n FROM users')).rows[0].n === 0 }), { public: true, idempotent: false });
  const login = { ...text(32, 3), pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]+$' };
  route('POST', '/auth/register', 'Зарегистрироваться и получить резервный код', object({ login, display_name: text(80), password: text(200, 12), invite: text(100) }, ['login', 'display_name', 'password']), async (tx, _, req, reply) => {
    const { user, recovery } = await createUser(tx, req.body, registration);
    return { ...await newSession(tx, user, reply, secure), recovery_code: recovery };
  }, { public: true, idempotent: false, authRate: true });
  route('POST', '/auth/login', 'Войти по логину и паролю', object({ login: text(32), password: text(200) }), async (tx, _, req, reply) =>
    newSession(tx, await verifyLogin(tx, req.body.login, req.body.password), reply, secure), { public: true, idempotent: false, authRate: true });
  route('POST', '/auth/recover', 'Сменить пароль резервным кодом и отозвать доступы', object({ login: text(32), recovery_code: text(100), password: text(200, 12) }), async (tx, _, req, reply) => {
    const u = (await tx.query('SELECT * FROM users WHERE login=$1', [req.body.login.toLowerCase()])).rows[0];
    if (!u || !equal(digest(req.body.recovery_code), u.recovery_hash)) throw new Problem(401, 'INVALID_CREDENTIALS', 'Неверный логин или резервный код');
    const recovery = token();
    await tx.query('UPDATE users SET password_hash=$1,recovery_hash=$2 WHERE id=$3', [await passwordHash(req.body.password), digest(recovery), u.id]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
    await tx.query('UPDATE agents SET revoked_at=$1 WHERE owner_id=$2 AND revoked_at IS NULL', [Date.now(), u.id]);
    await tx.query(`UPDATE work_sessions SET state='expired' WHERE owner_id=$1 AND state IN ('active','paused','review')`, [u.id]);
    return { ...await newSession(tx, u, reply, secure), recovery_code: recovery };
  }, { public: true, idempotent: false, authRate: true });
  route('POST', '/auth/logout', 'Завершить вход', object({}), async (tx, a, _, reply) => {
    human(a); await tx.query('DELETE FROM sessions WHERE hash=$1', [a.sessionHash]); reply.clearCookie('d2d_session', { path: '/' }); return { ok: true };
  }, { idempotent: false });
  route('GET', '/me', 'Текущий пользователь или агент', null, async (tx, a) => ({
    user: publicUser((await tx.query('SELECT * FROM users WHERE id=$1', [a.userId])).rows[0]), csrf: a.csrf, agent_id: a.agentId, scopes: a.scopes,
  }));
  route('GET', '/capabilities', 'Реально реализованные возможности', null, async () => ({ api_version: 'v1', work_sessions: true, tasks: true, agents: true,
    forgejo: false, git_write: false, reviews: false, builds: false, releases: false, deployments: false, mcp: false }));
  route('POST', '/invites', 'Создать приглашение на регистрацию', object({}), async (tx, a) => {
    human(a); if (a.role !== 'owner') throw new Problem(403, 'FORBIDDEN', 'Приглашения создаёт владелец платформы');
    const raw = token(), expires = Date.now() + 86400000;
    await tx.query('INSERT INTO invites VALUES ($1,$2,$3,NULL)', [digest(raw), a.id, expires]);
    return { invite: raw, expires_at: expires };
  }, { idempotent: false });
  route('GET', '/projects', 'Список доступных проектов, по 50 на страницу', null, async (tx, a, req) => paginate(await listProjects(tx, a), page(req)));
  route('POST', '/projects', 'Создать проект', object({ name: text(100), slug: { ...text(60, 2), pattern: '^[a-z0-9][a-z0-9-]+$' }, description: text(2000, 0) }, ['name', 'slug']), async (tx, a, req) => {
    human(a); const projectId = id();
    await tx.query('INSERT INTO projects (id,slug,name,description,owner_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [projectId, req.body.slug, req.body.name, req.body.description ?? '', a.id, Date.now()]);
    await tx.query('INSERT INTO members VALUES ($1,$2,$3)', [projectId, a.id, 'admin']);
    await event(tx, a, projectId, 'project.created', 'Создан проект');
    return { project: (await listProjects(tx, a)).find(x => x.id === projectId) };
  });
  route('GET', '/projects/:id', 'Проект, задачи, участники и последние 100 событий', null, async (tx, a, req) => {
    const project = await member(tx, a, p(req));
    return { project: { ...project, work: await currentWork(tx, p(req)) },
      tasks: (await tx.query('SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 500', [p(req)])).rows,
      members: (await tx.query('SELECT u.id,u.login,u.display_name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.display_name', [p(req)])).rows,
      events: (await tx.query('SELECT * FROM events WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [p(req)])).rows,
      handoffs: (await tx.query(`SELECT h.*,u.display_name AS requester_name FROM handoffs h JOIN users u ON u.id=h.requested_by JOIN work_sessions w ON w.id=h.session_id
        WHERE w.project_id=$1 AND h.state='pending' AND w.state IN ('active','paused','review') AND w.expires_at>$2 ORDER BY h.created_at`, [p(req), Date.now()])).rows,
      agents: a.agentId || project.member_role !== 'admin' ? [] : (await tx.query('SELECT id,name,scopes,expires_at,revoked_at FROM agents WHERE project_id=$1 ORDER BY created_at DESC', [p(req)])).rows,
    };
  });
  route('POST', '/projects/:id/members', 'Добавить зарегистрированного участника', object({ login: text(32), role: choice('admin', 'developer', 'viewer') }), async (tx, a, req) => {
    await admin(tx, a, p(req));
    const u = (await tx.query('SELECT id FROM users WHERE login=$1', [req.body.login.toLowerCase()])).rows[0];
    if (!u) throw new Problem(422, 'USER_NOT_FOUND', 'Пользователь должен сначала зарегистрироваться');
    await tx.query('INSERT INTO members VALUES ($1,$2,$3)', [p(req), u.id, req.body.role]);
    await event(tx, a, p(req), 'member.added', `Добавлен участник ${req.body.login}`, { user_id: u.id, role: req.body.role });
    return { ok: true };
  });
  route('GET', '/projects/:id/tasks', 'Задачи проекта, по 50 на страницу', null, async (tx, a, req) => {
    await member(tx, a, p(req)); return paginate((await tx.query('SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC,id DESC', [p(req)])).rows, page(req));
  });
  route('POST', '/projects/:id/tasks', 'Создать задачу', object({ title: text(200), description: text(10000, 0), priority: choice('low', 'normal', 'high') }, ['title']), async (tx, a, req) => {
    await member(tx, a, p(req), true); const taskId = id(), now = Date.now();
    await tx.query('INSERT INTO tasks (id,project_id,title,description,priority,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [taskId, p(req), req.body.title, req.body.description ?? '', req.body.priority ?? 'normal', a.userId, now]);
    await event(tx, a, p(req), 'task.created', `Создана задача «${req.body.title}»`);
    return { task: (await tx.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0] };
  });
  route('PATCH', '/tasks/:id', 'Сменить статус задачи с If-Match и текущим поколением', object({ status: choice('todo', 'in_progress', 'review', 'done'), generation }), async (tx, a, req) => {
    const task = (await tx.query('SELECT * FROM tasks WHERE id=$1', [p(req)])).rows[0];
    if (!task) throw new Problem(404, 'NOT_FOUND', 'Задача не найдена');
    const work = await ownedWork(tx, a, task.project_id, req.body.generation);
    if (!req.headers['if-match']) throw new Problem(428, 'VERSION_REQUIRED', 'Передайте If-Match с версией задачи');
    if (String(req.headers['if-match']).replaceAll('"', '') !== String(task.version)) throw new Problem(412, 'VERSION_CONFLICT', 'Задача изменилась. Обновите её');
    const updated = (await tx.query('UPDATE tasks SET status=$1,version=version+1,updated_at=$2 WHERE id=$3 RETURNING *', [req.body.status, Date.now(), task.id])).rows[0];
    await event(tx, a, task.project_id, 'task.updated', `Обновлён статус задачи «${task.title}»`, { task_id: task.id, status: req.body.status, generation: work.generation, work_session_id: work.id });
    return { task: updated };
  });
  route('POST', '/projects/:id/work-sessions', 'Взять проект в разработку, срок 15–120 минут', object({ note: text(2000), task_id: text(80), minutes: integer(15, 120) }, ['note']), async (tx, a, req) => {
    await member(tx, a, p(req), true); await lockProject(tx, p(req));
    const work = await currentWork(tx, p(req));
    if (work) throw new Problem(409, 'PROJECT_BUSY', 'Проект уже взят в разработку', { owner: work.owner_name, work_session_id: work.id });
    if (req.body.task_id && !(await tx.query('SELECT id FROM tasks WHERE id=$1 AND project_id=$2', [req.body.task_id, p(req)])).rows.length)
      throw new Problem(422, 'INVALID_TASK', 'Задача не принадлежит проекту');
    const gen = (await tx.query('UPDATE projects SET generation=generation+1 WHERE id=$1 RETURNING generation', [p(req)])).rows[0].generation;
    const workId = id(), now = Date.now();
    await tx.query(`INSERT INTO work_sessions (id,project_id,owner_id,executor_id,generation,task_id,note,state,branch,started_at,expires_at,heartbeat_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$9)`, [workId, p(req), a.userId, a.id, gen, req.body.task_id ?? null, req.body.note, `task/${workId.slice(0, 8)}`, now, now + (req.body.minutes ?? 120) * 60000]);
    await event(tx, a, p(req), 'work.started', `Проект взят в разработку: ${req.body.note}`, { generation: gen, responsible_user_id: a.userId });
    return { work: await currentWork(tx, p(req)) };
  });
  async function sessionProject(tx: SQL, a: Actor, workId: string) {
    const w = (await tx.query('SELECT * FROM work_sessions WHERE id=$1', [workId])).rows[0];
    if (!w) throw new Problem(404, 'NOT_FOUND', 'Рабочая сессия не найдена');
    await member(tx, a, w.project_id); return w;
  }
  async function sessionOwned(tx: SQL, a: Actor, req: ApiRequest) {
    const w = await sessionProject(tx, a, p(req));
    const current = await ownedWork(tx, a, w.project_id, req.body.generation);
    if (w.id !== current.id) throw new Problem(409, 'STALE_LEASE', 'Эта рабочая сессия завершена');
    return current;
  }
  route('POST', '/work-sessions/:id/heartbeat', 'Обновить связь без продления срока', object({ generation }), async (tx, a, req) => {
    const w = await sessionOwned(tx, a, req);
    await tx.query('UPDATE work_sessions SET heartbeat_at=$1 WHERE id=$2', [Date.now(), w.id]);
    return { work: await currentWork(tx, w.project_id) };
  });
  route('POST', '/work-sessions/:id/renew', 'Продлить сессию максимум до 8 часов от начала', object({ generation, minutes: integer(15, 120) }), async (tx, a, req) => {
    const w = await sessionOwned(tx, a, req);
    const expires = Math.min(Date.now() + req.body.minutes * 60000, Number(w.started_at) + 8 * 3600000);
    if (expires <= Number(w.expires_at)) throw new Problem(409, 'RENEW_LIMIT', 'Текущий срок уже покрывает продление или достигнут предел 8 часов');
    await tx.query('UPDATE work_sessions SET expires_at=$1 WHERE id=$2', [expires, w.id]);
    await event(tx, a, w.project_id, 'work.renewed', 'Продлён срок рабочей сессии');
    return { work: await currentWork(tx, w.project_id) };
  });
  route('POST', '/work-sessions/:id/state', 'Приостановить или возобновить работу', object({ generation, state: choice('active', 'paused', 'review') }), async (tx, a, req) => {
    const w = await sessionOwned(tx, a, req);
    await tx.query('UPDATE work_sessions SET state=$1 WHERE id=$2', [req.body.state, w.id]);
    await event(tx, a, w.project_id, 'work.state', 'Изменено состояние работы', { state: req.body.state });
    return { work: await currentWork(tx, w.project_id) };
  });
  route('POST', '/work-sessions/:id/transfer-requests', 'Запросить передачу без смены владельца', object({ note: text(2000) }), async (tx, a, req) => {
    human(a); const w = await sessionProject(tx, a, p(req)); await member(tx, a, w.project_id, true);
    if (!['active', 'paused', 'review'].includes(w.state) || Number(w.expires_at) <= Date.now()) throw new Problem(409, 'LEASE_EXPIRED', 'Сессия завершена');
    if (w.executor_id === a.id) throw new Problem(409, 'OWN_SESSION', 'Вы уже исполнитель этой сессии');
    if ((await tx.query("SELECT id FROM handoffs WHERE session_id=$1 AND requested_by=$2 AND state='pending'", [w.id, a.id])).rows.length)
      throw new Problem(409, 'REQUEST_EXISTS', 'Ваш запрос уже ожидает решения');
    const requestId = id(); await tx.query('INSERT INTO handoffs (id,session_id,requested_by,note,created_at) VALUES ($1,$2,$3,$4,$5)', [requestId, w.id, a.id, req.body.note, Date.now()]);
    await event(tx, a, w.project_id, 'work.transfer_requested', 'Запрошена передача проекта', { note: req.body.note }); return { id: requestId };
  });
  route('POST', '/work-sessions/:id/handoff', 'Передать проект участнику с заметкой и новым поколением', object({ generation, to_user_id: text(80), summary: text(10000) }), async (tx, a, req) => {
    human(a); const w = await sessionProject(tx, a, p(req)); const project = await member(tx, a, w.project_id, true);
    await lockProject(tx, w.project_id); const current = await currentWork(tx, w.project_id);
    if (!current || current.id !== w.id || current.generation !== req.body.generation) throw new Problem(409, 'STALE_LEASE', 'Рабочая сессия изменилась');
    if (current.owner_id !== a.userId && project.member_role !== 'admin') throw new Problem(403, 'FORBIDDEN', 'Передача доступна владельцу сессии или администратору');
    const target = (await tx.query("SELECT m.*,u.display_name FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.role<>'viewer'", [w.project_id, req.body.to_user_id])).rows[0];
    if (!target || (target.user_id === current.owner_id && current.executor_id === target.user_id)) throw new Problem(422, 'INVALID_TARGET', 'Выберите другого участника с правом разработки');
    await tx.query("UPDATE work_sessions SET state='transferred',summary=$1 WHERE id=$2", [req.body.summary, w.id]);
    const gen = (await tx.query('UPDATE projects SET generation=generation+1 WHERE id=$1 RETURNING generation', [w.project_id])).rows[0].generation;
    const now = Date.now();
    await tx.query(`INSERT INTO work_sessions (id,project_id,owner_id,executor_id,generation,task_id,note,state,branch,started_at,expires_at,heartbeat_at,summary)
      VALUES ($1,$2,$3,$3,$4,$5,$6,'active',$7,$8,$9,$8,$10)`, [id(), w.project_id, target.user_id, gen, w.task_id, w.note, w.branch, now, now + 2 * 3600000, req.body.summary]);
    await tx.query("UPDATE handoffs SET state=CASE WHEN requested_by=$1 THEN 'accepted' ELSE 'closed' END WHERE session_id=$2 AND state='pending'", [target.user_id, w.id]);
    await event(tx, a, w.project_id, 'work.transferred', `Проект передан: ${target.display_name}`, { summary: req.body.summary, generation: gen, forced: current.owner_id !== a.userId });
    return { work: await currentWork(tx, w.project_id) };
  });
  route('POST', '/work-sessions/:id/finish', 'Завершить работу с итоговой заметкой', object({ generation, summary: text(10000) }), async (tx, a, req) => {
    const w = await sessionOwned(tx, a, req);
    await tx.query("UPDATE work_sessions SET state='finished',summary=$1 WHERE id=$2", [req.body.summary, w.id]);
    await tx.query("UPDATE handoffs SET state='closed' WHERE session_id=$1 AND state='pending'", [w.id]);
    await event(tx, a, w.project_id, 'work.finished', 'Работа завершена, проект свободен', { summary: req.body.summary });
    return { ok: true };
  });
  route('POST', '/projects/:id/agents', 'Выдать ограниченный токен агента, показывается один раз', object({ name: text(100), scopes: { type: 'array', items: choice('read', 'write'), minItems: 1, maxItems: 2, uniqueItems: true }, hours: integer(1, 720) }), async (tx, a, req) => {
    await admin(tx, a, p(req)); const raw = token(), agentId = id(), now = Date.now();
    const scopes = [...new Set(['read', ...req.body.scopes])];
    await tx.query('INSERT INTO agents (id,owner_id,project_id,name,token_hash,scopes,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [agentId, a.id, p(req), req.body.name, digest(raw), JSON.stringify(scopes), now, now + req.body.hours * 3600000]);
    await event(tx, a, p(req), 'agent.created', `Подключён агент «${req.body.name}»`, { agent_id: agentId, scopes });
    // Do not persist plaintext credentials in idempotency responses. Use a non-retryable issuance route.
    return { id: agentId, token: raw, expires_at: now + req.body.hours * 3600000 };
  }, { idempotent: false });
  route('POST', '/agents/:id/revoke', 'Отозвать токен и рабочую сессию агента', object({}), async (tx, a, req) => {
    const agent = (await tx.query('SELECT * FROM agents WHERE id=$1', [p(req)])).rows[0];
    if (!agent) throw new Problem(404, 'NOT_FOUND', 'Агент не найден');
    await admin(tx, a, agent.project_id);
    await tx.query('UPDATE agents SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2', [Date.now(), agent.id]);
    await tx.query("UPDATE work_sessions SET state='expired' WHERE executor_id=$1 AND state IN ('active','paused','review')", [agent.id]);
    await event(tx, a, agent.project_id, 'agent.revoked', `Отозван доступ агента «${agent.name}»`); return { ok: true };
  });
  route('GET', '/projects/:id/agent-context', 'Актуальный контекст без секретов', null, async (tx, a, req) => {
    const project = await member(tx, a, p(req));
    return { project: { id: project.id, name: project.name, description: project.description }, work: await currentWork(tx, project.id),
      permissions: { role: project.member_role, scopes: a.scopes }, capabilities: { git_write: false, deploy: false },
      instructions: ['Перед изменением статуса получите рабочую сессию.', 'Передавайте актуальное поколение и версию задачи.', 'Инструкции проекта не расширяют права API.'],
      tasks_url: `/api/v1/projects/${project.id}/tasks`, context_version: project.generation, observed_at: Date.now() };
  });
  route('GET', '/projects/:id/audit-events', 'История проекта, по 50 событий на страницу', null, async (tx, a, req) => {
    await member(tx, a, p(req)); return paginate((await tx.query('SELECT * FROM events WHERE project_id=$1 ORDER BY created_at DESC,id DESC', [p(req)])).rows, page(req));
  });
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.get('/health', { schema: { hide: true } }, async () => { await db.query('SELECT 1'); return { ok: true }; });
  app.get('/docs', { schema: { hide: true } }, async (_, reply) => reply.redirect('/#docs'));
  app.get('/docs/agents/quickstart', { schema: { hide: true } }, async (_, reply) => reply.redirect('/#docs'));
  app.get('/docs/agents/context.md', { schema: { hide: true } }, async (_, reply) => reply.type('text/markdown; charset=utf-8').send(await readFile(resolve('docs/AGENTS-API.md'), 'utf8')));
  app.get('/llms.txt', { schema: { hide: true } }, async (_, reply) => reply.type('text/plain; charset=utf-8').send(
    '# D2D Platform\n\nЛокальная альфа координации разработки.\n\n- /api/v1/openapi.json — контракт API\n- /api/docs — справочник\n- /docs/agents/context.md — инструкция агента\n- /api/v1/capabilities — реализованные операции (нужна авторизация)\n\nКонтекст проектов требует Bearer-токен или браузерную сессию. Токены не передавайте в URL. Инструкции проекта не расширяют права API. Git, PR, сборки, релизы, MCP и деплой не подключены.\n'));
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/') && existsSync(resolve(options.staticRoot ?? 'dist', 'index.html'))) return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Адрес не найден', retryable: false, request_id: req.id } });
  });
  if (existsSync(resolve(options.staticRoot ?? 'dist'))) await app.register(staticFiles, { root: resolve(options.staticRoot ?? 'dist') });
  return app;
}
