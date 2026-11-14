import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { database, type Database } from './db.ts';
import { createApp } from './app.ts';

describe('Локальный рабочий процесс', () => {
  let db: Database, app: FastifyInstance;
  type Client = { cookie?: string; csrf?: string; bearer?: string; user?: any; recovery?: string };
  let alice: Client, bob: Client, eve: Client, project: any, task: any;
  async function call(client: Client, method: any, path: string, body?: any, headers: Record<string, string> = {}) {
    return app.inject({ method, url: `/api/v1${path}`, ...(body === undefined ? {} : { payload: body }), headers: {
      ...(client.cookie ? { cookie: client.cookie, 'x-csrf-token': client.csrf! } : {}),
      ...(client.bearer ? { authorization: `Bearer ${client.bearer}` } : {}),
      'idempotency-key': randomUUID(), ...headers,
    } });
  }
  async function register(login: string): Promise<Client> {
    const r = await call({}, 'POST', '/auth/register', { login, display_name: login, password: 'safe-local-password-123' });
    assert.equal(r.statusCode, 200, r.body); const data = r.json();
    return { cookie: r.cookies[0].name + '=' + r.cookies[0].value, csrf: data.csrf, user: data.user, recovery: data.recovery_code };
  }
  async function start(client: Client, note = 'Проверка сессии') {
    return call(client, 'POST', `/projects/${project.id}/work-sessions`, { note });
  }
  before(async () => {
    // TEST_DATABASE_URL must point to a dedicated EMPTY database; tests create real schema.
    db = await database(process.env.TEST_DATABASE_URL);
    app = await createApp({ db, registration: 'open' }); await app.ready();
    alice = await register('alice'); bob = await register('bob'); eve = await register('eve');
    const r = await call(alice, 'POST', '/projects', { name: 'Учебный проект', slug: 'sandbox', description: 'Изолированная проверка' });
    assert.equal(r.statusCode, 200, r.body); project = r.json().project;
    for (const [user, role] of [[bob, 'developer'], [eve, 'viewer']] as const) {
      const m = await call(alice, 'POST', `/projects/${project.id}/members`, { login: user.user.login, role }); assert.equal(m.statusCode, 200, m.body);
    }
    const t = await call(alice, 'POST', `/projects/${project.id}/tasks`, { title: 'Проверить передачу' }); task = t.json().task;
  });
  after(async () => { await app?.close(); await db?.close(); });
  it('проверяет аутентификацию, CSRF и Origin', async () => {
    assert.equal((await call({}, 'GET', '/projects')).statusCode, 401);
    assert.equal((await call(alice, 'POST', '/projects', { name: 'x', slug: 'xx' }, { 'x-csrf-token': 'wrong' })).statusCode, 403);
    assert.equal((await call(alice, 'POST', '/projects', { name: 'x', slug: 'xx' }, { origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await call(eve, 'POST', `/projects/${project.id}/tasks`, { title: 'Нет прав' })).statusCode, 403);
  });
  it('изолирует проекты и не раскрывает чужие задачи', async () => {
    const other = (await call(bob, 'POST', '/projects', { name: 'Скрытый проект', slug: 'private' })).json().project;
    assert.equal((await call(alice, 'GET', `/projects/${other.id}`)).statusCode, 404);
    assert.equal((await call(alice, 'GET', `/projects/${other.id}/agent-context`)).statusCode, 404);
    const t = (await call(bob, 'POST', `/projects/${other.id}/tasks`, { title: 'Скрытая задача' })).json().task;
    assert.equal((await call(alice, 'PATCH', `/tasks/${t.id}`, { status: 'done', generation: 1 }, { 'if-match': '1' })).statusCode, 404);
    const list = (await call(alice, 'GET', '/projects')).json().data;
    assert.equal(list.some((x: any) => x.id === other.id), false);
  });
  it('выдаёт ровно одну сессию при 50 одновременных попытках', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => start(i % 2 ? alice : bob)));
    assert.equal(results.filter(x => x.statusCode === 200).length, 1, results.map(x => x.body).join('\n'));
    assert.equal(results.filter(x => x.statusCode === 409 && x.json().error.code === 'PROJECT_BUSY').length, 49);
    const w = results.find(x => x.statusCode === 200)!.json().work;
    const owner = w.executor_id === alice.user.id ? alice : bob;
    assert.equal((await call(owner, 'POST', `/work-sessions/${w.id}/finish`, { generation: w.generation, summary: 'Гонка проверена' })).statusCode, 200);
  });
  it('повторяет результат ключа после потери ответа и отклоняет другое тело', async () => {
    const key = randomUUID(), body = { note: 'Идемпотентная сессия' };
    const [r1, r2] = await Promise.all([1, 2].map(() => call(alice, 'POST', `/projects/${project.id}/work-sessions`, body, { 'idempotency-key': key })));
    assert.equal(r1.statusCode, 200, r1.body); assert.deepEqual(r1.json(), r2.json());
    const conflict = await call(alice, 'POST', `/projects/${project.id}/work-sessions`, { note: 'Другой запрос' }, { 'idempotency-key': key });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const w = r1.json().work;
    await call(alice, 'POST', `/work-sessions/${w.id}/finish`, { generation: w.generation, summary: 'Готово' });
  });
  it('передаёт проект и блокирует старое поколение, URL и исполнителя', async () => {
    const w = (await start(alice)).json().work;
    assert.equal((await call(bob, 'POST', `/work-sessions/${w.id}/transfer-requests`, { note: 'Возьму после тебя' })).statusCode, 200);
    const r = await call(alice, 'POST', `/work-sessions/${w.id}/handoff`, { generation: w.generation, to_user_id: bob.user.id, summary: 'Продолжить по задаче' });
    assert.equal(r.statusCode, 200, r.body); const next = r.json().work;
    assert.ok(next.generation > w.generation); assert.equal(next.branch, w.branch);
    assert.equal((await call(alice, 'POST', `/work-sessions/${w.id}/heartbeat`, { generation: w.generation })).statusCode, 409);
    assert.equal((await call(bob, 'POST', `/work-sessions/${next.id}/heartbeat`, { generation: w.generation })).json().error.code, 'STALE_LEASE');
    assert.equal((await call(bob, 'POST', `/work-sessions/${w.id}/finish`, { generation: next.generation, summary: 'Старый URL' })).statusCode, 409);
    const old = await call(alice, 'PATCH', `/tasks/${task.id}`, { status: 'done', generation: w.generation }, { 'if-match': '1' }); assert.equal(old.statusCode, 409);
    const updated = await call(bob, 'PATCH', `/tasks/${task.id}`, { status: 'in_progress', generation: next.generation }, { 'if-match': '1' }); assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((await call(bob, 'PATCH', `/tasks/${task.id}`, { status: 'done', generation: next.generation }, { 'if-match': '1' })).statusCode, 412);
    await call(bob, 'POST', `/work-sessions/${next.id}/finish`, { generation: next.generation, summary: 'Передача проверена' });
  });
  it('heartbeat не продлевает срок, потеря связи не освобождает проект', async () => {
    const w = (await start(alice)).json().work;
    await db.query('UPDATE work_sessions SET heartbeat_at=$1 WHERE id=$2', [Date.now() - 5 * 60000, w.id]);
    assert.equal((await start(bob)).statusCode, 409);
    const hb = await call(alice, 'POST', `/work-sessions/${w.id}/heartbeat`, { generation: w.generation });
    assert.equal(hb.json().work.expires_at, w.expires_at);
    await db.query('UPDATE work_sessions SET expires_at=$1 WHERE id=$2', [Date.now() - 1, w.id]);
    assert.equal((await call(alice, 'POST', `/work-sessions/${w.id}/heartbeat`, { generation: w.generation })).json().error.code, 'LEASE_EXPIRED');
    const next = await start(bob); assert.equal(next.statusCode, 200, next.body);
    const nw = next.json().work; assert.ok(nw.generation > w.generation);
    await call(bob, 'POST', `/work-sessions/${nw.id}/finish`, { generation: nw.generation, summary: 'Срок проверен' });
  });
  it('согласует передачу с конкурентной записью и запрещает последующую старую запись', async () => {
    const work = (await start(alice, 'Проверка конкурентной передачи')).json().work;
    const currentTask = (await call(alice, 'GET', `/projects/${project.id}`)).json().tasks.find((t: any) => t.id === task.id);
    const [update, transfer] = await Promise.all([
      call(alice, 'PATCH', `/tasks/${task.id}`, { status: 'review', generation: work.generation }, { 'if-match': String(currentTask.version) }),
      call(alice, 'POST', `/work-sessions/${work.id}/handoff`, { generation: work.generation, to_user_id: bob.user.id, summary: 'Передача одновременно с обновлением статуса' }),
    ]);
    assert.equal(transfer.statusCode, 200, transfer.body);
    assert.ok([200, 409].includes(update.statusCode), update.body);
    const card = (await call(bob, 'GET', `/projects/${project.id}`)).json();
    const savedTask = card.tasks.find((t: any) => t.id === task.id);
    assert.equal(savedTask.version, currentTask.version + (update.statusCode === 200 ? 1 : 0));
    assert.ok(card.project.work.generation > work.generation);
    const stale = await call(alice, 'PATCH', `/tasks/${task.id}`, { status: 'done', generation: work.generation }, { 'if-match': String(savedTask.version) });
    assert.equal(stale.statusCode, 409);
    const next = transfer.json().work;
    await call(bob, 'POST', `/work-sessions/${next.id}/finish`, { generation: next.generation, summary: 'Конкурентная передача проверена' });
  });
  it('требует права, сессию и CAS для задач; проверяет входные данные', async () => {
    assert.equal((await call(alice, 'PATCH', `/tasks/${task.id}`, { status: 'done', generation: 999 }, { 'if-match': '2' })).statusCode, 409);
    assert.equal((await call(alice, 'POST', `/projects/${project.id}/tasks`, { title: '' })).statusCode, 422);
    assert.equal((await call(alice, 'POST', `/projects/${project.id}/tasks`, { title: 'x', injected: true })).statusCode, 422);
    assert.equal((await call(alice, 'POST', `/projects/${project.id}/work-sessions`, { note: 'x', minutes: -1 })).statusCode, 422);
    const missing = await call(alice, 'POST', `/projects/${project.id}/tasks`, { title: 'x' }, { 'idempotency-key': '' }); assert.equal(missing.statusCode, 422);
    assert.equal((await call(alice, 'POST', `/projects/${project.id}/tasks`, { title: '   ' })).statusCode, 422);
    assert.equal((await call(alice, 'GET', '/projects?page=-1')).statusCode, 422);
    const w = (await start(alice)).json().work;
    assert.equal((await call(alice, 'PATCH', `/tasks/${task.id}`, { status: 'done', generation: w.generation })).statusCode, 428);
    await call(alice, 'POST', `/work-sessions/${w.id}/finish`, { generation: w.generation, summary: 'Поля и версии проверены' });
  });
  it('ограничивает агента проектом и scope, отзыв немедленно прекращает новые операции', async () => {
    const reader = (await call(alice, 'POST', `/projects/${project.id}/agents`, { name: 'Читатель', scopes: ['read'], hours: 1 })).json();
    assert.ok(reader.token); assert.equal((await start({ bearer: reader.token })).statusCode, 403);
    const issued = (await call(alice, 'POST', `/projects/${project.id}/agents`, { name: 'Разработчик', scopes: ['write'], hours: 1 })).json();
    const agent = { bearer: issued.token };
    assert.equal((await call(agent, 'POST', '/projects', { name: 'Нет', slug: 'nope' })).statusCode, 403);
    const own = (await call(agent, 'GET', '/projects')).json().data; assert.equal(own.length, 1);
    const other = (await call(bob, 'GET', '/projects')).json().data.find((x: any) => x.id !== project.id);
    assert.equal((await call(agent, 'GET', `/projects/${other.id}`)).statusCode, 404);
    const w = (await start(agent)).json().work; assert.equal(w.executor_id, issued.id);
    const result = await call(alice, 'POST', `/agents/${issued.id}/revoke`, {}); assert.equal(result.statusCode, 200);
    assert.equal((await call(agent, 'POST', `/work-sessions/${w.id}/heartbeat`, { generation: w.generation })).statusCode, 401);
    assert.equal((await call(agent, 'GET', `/projects/${project.id}/agent-context`)).statusCode, 401);
    const next = (await start(bob)).json().work;
    await call(bob, 'POST', `/work-sessions/${next.id}/finish`, { generation: next.generation, summary: 'Агент отозван' });
    const secrets = (await db.query('SELECT response FROM idempotency')).rows;
    assert.ok(!JSON.stringify(secrets).includes(issued.token));
    await db.query('UPDATE agents SET expires_at=$1 WHERE id=$2', [Date.now() - 1, reader.id]);
    assert.equal((await call({ bearer: reader.token }, 'GET', '/me')).statusCode, 401);
  });
  it('восстановление меняет резервный код и отзывает браузерные сессии', async () => {
    const r = await call({}, 'POST', '/auth/recover', { login: 'eve', recovery_code: eve.recovery, password: 'replacement-password-123' });
    assert.equal(r.statusCode, 200, r.body); assert.notEqual(r.json().recovery_code, eve.recovery);
    assert.equal((await call(eve, 'GET', '/me')).statusCode, 401);
    assert.equal((await call({}, 'POST', '/auth/recover', { login: 'eve', recovery_code: eve.recovery, password: 'replacement-password-123' })).statusCode, 401);
  });
  it('публикует OpenAPI и честные capabilities', async () => {
    const api = await call({}, 'GET', '/openapi.json'); assert.equal(api.statusCode, 200);
    assert.equal(api.json().openapi, '3.0.3'); assert.ok(api.json().paths['/api/v1/work-sessions/{id}/handoff']);
    const caps = (await call(alice, 'GET', '/capabilities')).json(); assert.equal(caps.git_write, false); assert.equal(caps.deployments, true);assert.equal(caps.source_upload,true);
    const events = (await call(alice, 'GET', `/projects/${project.id}/audit-events`)).json().data;
    assert.ok(events.some((x: any) => x.kind === 'work.transferred'));
  });
  it('не раскрывает сохранённый ответ после отзыва членства или понижения роли', async () => {
    const key = randomUUID(), payload = { title: 'Ответ с проверкой членства' };
    const path = `/projects/${project.id}/tasks`;
    const first = await call(bob, 'POST', path, payload, { 'idempotency-key': key }); assert.equal(first.statusCode, 200);
    await db.query("UPDATE members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, bob.user.id]);
    assert.equal((await call(bob, 'POST', path, payload, { 'idempotency-key': key })).statusCode, 403);
    await db.query('DELETE FROM members WHERE project_id=$1 AND user_id=$2', [project.id, bob.user.id]);
    assert.equal((await call(bob, 'POST', path, payload, { 'idempotency-key': key })).statusCode, 404);
    await db.query("INSERT INTO members VALUES ($1,$2,'developer')", [project.id, bob.user.id]);
  });
});

it('закрытая регистрация требует приглашения после первого пользователя', async () => {
  const db = await database(); const app = await createApp({ db });
  try {
    const payload = { login: 'first', display_name: 'Первый', password: 'long-password-1234' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload }); assert.equal(first.statusCode, 200);
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...payload, login: 'second' } });
    assert.equal(second.statusCode, 403); assert.equal(second.json().error.code, 'INVITE_REQUIRED');
    const invite = await app.inject({ method: 'POST', url: '/api/v1/invites', payload: {}, headers: { cookie: `d2d_session=${first.cookies[0].value}`, 'x-csrf-token': first.json().csrf, 'idempotency-key': randomUUID() } });
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...payload, login: 'second', invite: invite.json().invite } }); assert.equal(accepted.statusCode, 200);
    const reused = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { ...payload, login: 'third', invite: invite.json().invite } }); assert.equal(reused.statusCode, 403);
  } finally { await app.close(); await db.close(); }
});
