import { database } from './db.ts';
import { createApp } from './app.ts';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)&&!(host==='0.0.0.0'&&process.env.ALLOW_CONTAINER_BIND==='1')) throw new Error('Публичный bind допускается только при ALLOW_CONTAINER_BIND=1 для контейнера');
const port = Number(process.env.PORT ?? 19090);
const db = await database(process.env.DATABASE_URL, process.env.DATA_DIR ?? '.d2d');
const registration = process.env.REGISTRATION_MODE ?? 'invite';
if (!['open', 'invite'].includes(registration)) throw new Error('REGISTRATION_MODE: open или invite');
const app = await createApp({ db, origin: process.env.PUBLIC_ORIGIN ?? `http://${host}:${port}`,
  devOrigin: process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:19091' : undefined,
  registration: registration as 'invite' | 'open', logger: true,setupToken:process.env.SETUP_TOKEN,dataDir:process.env.DATA_DIR??'.d2d',
  forgejo:process.env.FORGEJO_URL&&process.env.FORGEJO_TOKEN?{url:process.env.FORGEJO_URL,token:process.env.FORGEJO_TOKEN,owner:process.env.FORGEJO_OWNER??'d2d-service'}:undefined });
async function shutdown() { await app.close(); await db.close(); }
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host, port });
