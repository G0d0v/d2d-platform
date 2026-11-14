// Disposable in-memory fixture. Never reads or seeds the user's .d2d database.
import { database } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { randomUUID } from 'node:crypto';
const db = await database();
const app = await createApp({ db, origin: 'http://127.0.0.1:19092', registration: 'open' });
async function account(login, display_name) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { login, display_name, password: 'local-ui-test-only-123' } });
  return { cookie: `d2d_session=${r.cookies[0].value}`, csrf: r.json().csrf, user: r.json().user };
}
const owner = await account('qa_owner', 'Разработчик QA');
const colleague = await account('qa_colleague', 'Коллега QA');
async function write(client, path, payload) {
  const r = await app.inject({ method: 'POST', url: `/api/v1${path}`, payload, headers: { cookie: client.cookie, 'x-csrf-token': client.csrf, 'idempotency-key': randomUUID() } });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json();
}
for (const [name, slug, description, busy] of [
  ['D2D Platform', 'd2d-platform', 'Общее рабочее пространство разработчиков и ИИ-агентов', false],
  ['Учебный API', 'sample-api', 'Тестовый проект для проверки передачи работы', true],
  ['Документация команды', 'team-docs', 'Инструкции, архитектура и история принятых решений', false],
]) {
  const { project } = await write(owner, '/projects', { name, slug, description });
  await write(owner, `/projects/${project.id}/members`, { login: 'qa_colleague', role: 'developer' });
  await write(owner, `/projects/${project.id}/tasks`, { title: 'Проверить сценарий передачи проекта', description: 'Начать работу, передать контекст коллеге и проверить отзыв старого поколения.', priority: 'high' });
  await write(owner, `/projects/${project.id}/tasks`, { title: 'Дополнить руководство для агента', description: 'Привести примеры ошибок API и условий повторного запроса.' });
  if (busy) await write(colleague, `/projects/${project.id}/work-sessions`, { note: 'Проверяю обработку конфликтов и повторных запросов' });
}
await app.listen({ host: '127.0.0.1', port: 19092 });
console.log('Disposable UI fixture: http://127.0.0.1:19092 · qa_owner · local-ui-test-only-123');
async function stop() { await app.close(); await db.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
