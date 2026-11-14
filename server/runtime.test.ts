import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { database } from './db.ts';
import { createApp } from './app.ts';

async function cleanup(path: string) {
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  assert.ok(basename(path).startsWith('d2d-test-'));
  await rm(path, { recursive: true, force: true });
}
it('сохраняет владение, аудит и идемпотентность после перезапуска на диске', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd2d-test-'));
  let db = await database(undefined, folder), app = await createApp({ db });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { login: 'persistent', display_name: 'Тест сохранения', password: 'test-password-1234' } });
    assert.equal(r.statusCode, 200, r.body);
    const headers = { cookie: `d2d_session=${r.cookies[0].value}`, 'x-csrf-token': r.json().csrf, 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Дисковый проект', slug: 'persist' } });
    const projectId = created.json().project.id;
    headers['idempotency-key'] = randomUUID();
    const request = { method: 'POST' as const, url: `/api/v1/projects/${projectId}/work-sessions`, headers, payload: { note: 'Продолжить после рестарта' } };
    const first = await app.inject(request); assert.equal(first.statusCode, 200, first.body);
    await app.close(); await db.close();
    db = await database(undefined, folder); app = await createApp({ db });
    const retry = await app.inject(request); assert.equal(retry.statusCode, 200, retry.body); assert.deepEqual(retry.json(), first.json());
    const card = await app.inject({ url: `/api/v1/projects/${projectId}`, headers });
    assert.equal(card.json().project.work.id, first.json().work.id);
    assert.equal(card.json().events.filter((e: any) => e.kind === 'work.started').length, 1);
  } finally { await app.close(); await db.close(); await cleanup(folder); }
});

it('CLI проходит полный сценарий API с ограниченным токеном', async () => {
  const db = await database(), app = await createApp({ db });
  const folder = await mkdtemp(join(tmpdir(), 'd2d-test-'));
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { login: 'cli-owner', display_name: 'CLI тест', password: 'test-password-1234' } });
    const headers = { cookie: `d2d_session=${r.cookies[0].value}`, 'x-csrf-token': r.json().csrf, 'idempotency-key': randomUUID() };
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'CLI проект', slug: 'cli-project' } });
    const projectId = created.json().project.id;
    const issued = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/agents`, headers, payload: { name: 'CLI агент', scopes: ['write'], hours: 1 } });
    const bearer = issued.json().token;
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const run = async (args: string[]) => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'cli/index.ts', ...args, '--json'], { env: { ...process.env, D2D_URL: address, D2D_TOKEN: bearer } });
      assert.ok(!stdout.includes(bearer)); assert.ok(!stderr.includes(bearer)); return { data: JSON.parse(stdout), stderr };
    };
    assert.equal((await run(['whoami'])).data.agent_id, issued.json().id);
    assert.equal((await run(['projects'])).data.data.length, 1);
    const note = join(folder, 'intent.md'), summary = join(folder, 'summary.md');
    await writeFile(note, 'Проверить CLI'); await writeFile(summary, 'CLI проверен на настоящем HTTP API');
    const args = ['work', 'start', '--project', projectId, '--note-file', note, '--key', randomUUID()];
    const started = await run(args), retry = await run(args); assert.deepEqual(started.data, retry.data);
    const work = started.data.work;
    await run(['work', 'heartbeat', '--session', work.id, '--generation', String(work.generation)]);
    await run(['work', 'finish', '--session', work.id, '--generation', String(work.generation), '--summary-file', summary]);
    assert.equal((await run(['work', 'status', '--project', projectId])).data.work, null);
    assert.equal((await run(['capabilities'])).data.git_write, false);
  } finally { await app.close(); await db.close(); await cleanup(folder); }
});

it('выдаёт добавленный после запуска asset как JS и не подменяет отсутствующий HTML-страницей', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'd2d-test-'));
  const db = await database();
  await mkdir(join(folder, 'assets')); await writeFile(join(folder, 'index.html'), '<html lang="ru">SPA</html>');
  const app = await createApp({ db, staticRoot: folder });
  try {
    await app.ready(); await writeFile(join(folder, 'assets', 'new.js'), 'export const ready = true;');
    const asset = await app.inject('/assets/new.js'); assert.equal(asset.statusCode, 200); assert.match(asset.headers['content-type']!, /javascript/);
    assert.equal((await app.inject('/assets/missing.js')).statusCode, 404);
    assert.equal((await app.inject('/api/v1/not-real')).statusCode, 404);
    const spa = await app.inject('/workspace'); assert.equal(spa.statusCode, 200); assert.match(spa.body, /SPA/);
    assert.equal((await app.inject('/api/docs/')).statusCode, 200);
  } finally { await app.close(); await db.close(); await cleanup(folder); }
});
