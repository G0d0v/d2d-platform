import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const usage = `D2D CLI — API локальной альфы

Настройка: D2D_URL (по умолчанию http://127.0.0.1:19090), D2D_TOKEN (токен агента).
Токен не передаётся аргументом и не сохраняется CLI.

npm --silent run cli -- whoami
npm --silent run cli -- capabilities
npm --silent run cli -- projects [--page 1]
npm --silent run cli -- context --project ID
npm --silent run cli -- tasks --project ID [--page 1]
npm --silent run cli -- task create --project ID --title ТЕКСТ [--description-file ФАЙЛ]
npm --silent run cli -- task status --task ID --status todo|in_progress|review|done --version N --generation N
npm --silent run cli -- work start --project ID --note-file ФАЙЛ [--task ID] [--minutes 120]
npm --silent run cli -- work status --project ID
npm --silent run cli -- work heartbeat --session ID --generation N
npm --silent run cli -- work renew --session ID --generation N --minutes 120
npm --silent run cli -- work finish --session ID --generation N --summary-file ФАЙЛ

Любая мутация: [--key UUID]. Сохраните ключ для повтора после потери ответа.
--json: машинный JSON. Коды выхода: 0 успех, 2 аргументы/конфигурация, 3 API, 4 неизвестный результат/сеть.
Git, PR, сборки, релизы и деплой не реализованы. Авторизация и права проверяются сервером.`;
async function main() {
  const { positionals: [command, action], values: flags } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, project: { type: 'string' }, task: { type: 'string' },
    session: { type: 'string' }, generation: { type: 'string' }, minutes: { type: 'string' }, version: { type: 'string' },
    status: { type: 'string' }, title: { type: 'string' }, page: { type: 'string' }, key: { type: 'string' },
    'note-file': { type: 'string' }, 'summary-file': { type: 'string' }, 'description-file': { type: 'string' },
  } });
  if (flags.help || !command) { console.log(usage); return; }
  const need = (name: string) => { const value = flags[name as keyof typeof flags]; if (typeof value !== 'string' || !value) throw new Error(`Нужен --${name}`); return value; };
  const number = (name: string) => { const n = Number(need(name)); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name}: нужно положительное целое число`); return n; };
  const file = (name: string) => readFile(need(name), 'utf8');
  const segment = (name: string) => encodeURIComponent(need(name));
  let method = 'GET', path = '', body: unknown;
  const headers: Record<string, string> = {};
  if (command === 'whoami') path = '/me';
  else if (command === 'capabilities') path = '/capabilities';
  else if (command === 'projects') path = `/projects?page=${flags.page ? number('page') : 1}`;
  else if (command === 'context') path = `/projects/${segment('project')}/agent-context`;
  else if (command === 'tasks') path = `/projects/${segment('project')}/tasks?page=${flags.page ? number('page') : 1}`;
  else if (command === 'task' && action === 'create') {
    method = 'POST'; path = `/projects/${segment('project')}/tasks`; body = { title: need('title'), description: flags['description-file'] ? await file('description-file') : '' };
  } else if (command === 'task' && action === 'status') {
    method = 'PATCH'; path = `/tasks/${segment('task')}`; headers['If-Match'] = String(number('version')); body = { status: need('status'), generation: number('generation') };
  } else if (command === 'work' && action === 'status') path = `/projects/${segment('project')}/agent-context`;
  else if (command === 'work' && action === 'start') {
    method = 'POST'; path = `/projects/${segment('project')}/work-sessions`;
    body = { note: await file('note-file'), minutes: flags.minutes ? number('minutes') : 120, ...(flags.task ? { task_id: flags.task } : {}) };
  } else if (command === 'work' && ['heartbeat', 'renew', 'finish'].includes(action)) {
    method = 'POST'; path = `/work-sessions/${segment('session')}/${action}`;
    body = { generation: number('generation'), ...(action === 'renew' ? { minutes: number('minutes') } : {}), ...(action === 'finish' ? { summary: await file('summary-file') } : {}) };
  } else throw new Error('Неизвестная команда. Используйте --help');
  const origin = new URL(process.env.D2D_URL ?? 'http://127.0.0.1:19090');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
    throw new Error('D2D_URL должен быть HTTPS origin; HTTP разрешён только для loopback');
  const bearer = process.env.D2D_TOKEN;
  if (!bearer) throw new Error('Задайте D2D_TOKEN в окружении процесса');
  headers.Authorization = `Bearer ${bearer}`;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = flags.key ?? randomUUID();
    console.error(`Idempotency-Key: ${headers['Idempotency-Key']}`);
  }
  let response: Response;
  try { response = await fetch(new URL(`/api/v1${path}`, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { console.error('Нет подтверждённого ответа. Проверьте состояние и повторите с тем же --key; автоматического повтора нет.'); process.exitCode = 4; return; }
  const result = await response.json(); console.log(JSON.stringify(result, null, flags.json ? undefined : 2));
  if (!response.ok) process.exitCode = 3;
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
