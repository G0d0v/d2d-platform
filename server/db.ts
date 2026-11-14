import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type Row = Record<string, any>;
export interface SQL { query<T extends Row = Row>(sql: string, params?: any[]): Promise<{ rows: T[] }>; }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void>; }
export async function database(url?: string, directory?: string): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return {
      query: (sql, params) => pool.query(sql, params),
      async transaction(fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  if (directory) await mkdir(resolve(directory), { recursive: true });
  const db = await PGlite.create(directory ? resolve(directory) : undefined);
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: fn => db.transaction(tx => fn(tx)),
    close: () => db.close(),
  };
}

export async function migrate(db: Database) {
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(20261114)');
    await tx.query(`CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at bigint NOT NULL)`);
    if ((await tx.query('SELECT version FROM migrations WHERE version=1')).rows.length) return;
    // Keep statements separate: both node-postgres and PGlite use the same parameterized interface.
    const statements = [
      `CREATE TABLE control (id integer PRIMARY KEY); INSERT INTO control VALUES (1)`,
      `CREATE TABLE users (id text PRIMARY KEY, login text NOT NULL UNIQUE, display_name text NOT NULL,
        password_hash text NOT NULL, recovery_hash text NOT NULL, role text NOT NULL DEFAULT 'member', created_at bigint NOT NULL)`,
      `CREATE TABLE sessions (hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), csrf text NOT NULL, expires_at bigint NOT NULL)`,
      `CREATE TABLE projects (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
        color text NOT NULL DEFAULT 'mint', owner_id text NOT NULL REFERENCES users(id), generation integer NOT NULL DEFAULT 0,
        created_at bigint NOT NULL, UNIQUE(owner_id, slug))`,
      `CREATE TABLE members (project_id text NOT NULL REFERENCES projects(id), user_id text NOT NULL REFERENCES users(id),
        role text NOT NULL CHECK(role IN ('admin','developer','viewer')), PRIMARY KEY(project_id,user_id))`,
      `CREATE TABLE tasks (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), title text NOT NULL,
        description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
        priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')), version integer NOT NULL DEFAULT 1,
        created_by text NOT NULL REFERENCES users(id), created_at bigint NOT NULL, updated_at bigint NOT NULL)`,
      `CREATE TABLE work_sessions (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), owner_id text NOT NULL REFERENCES users(id),
        executor_id text NOT NULL, generation integer NOT NULL, task_id text REFERENCES tasks(id), note text NOT NULL,
        state text NOT NULL CHECK(state IN ('active','paused','review','finished','transferred','expired')),
        branch text NOT NULL, started_at bigint NOT NULL, expires_at bigint NOT NULL, heartbeat_at bigint NOT NULL, summary text NOT NULL DEFAULT '')`,
      `CREATE UNIQUE INDEX one_work_owner ON work_sessions(project_id) WHERE state IN ('active','paused','review')`,
      `CREATE TABLE handoffs (id text PRIMARY KEY, session_id text NOT NULL REFERENCES work_sessions(id),
        requested_by text NOT NULL REFERENCES users(id), note text NOT NULL, state text NOT NULL DEFAULT 'pending', created_at bigint NOT NULL)`,
      `CREATE TABLE agents (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id),
        name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes jsonb NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL,
        revoked_at bigint, last_seen_at bigint)`,
      `CREATE TABLE events (id text PRIMARY KEY, project_id text REFERENCES projects(id), actor_id text NOT NULL,
        actor_name text NOT NULL, kind text NOT NULL, message text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at bigint NOT NULL)`,
      `CREATE INDEX events_project_time ON events(project_id,created_at DESC)`,
      `CREATE TABLE idempotency (actor_id text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, response jsonb,
        created_at bigint NOT NULL, PRIMARY KEY(actor_id,key))`,
      `CREATE TABLE changes (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), session_id text NOT NULL REFERENCES work_sessions(id),
        generation integer NOT NULL, author_id text NOT NULL REFERENCES users(id), title text NOT NULL, description text NOT NULL DEFAULT '',
        state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','approved','changes_requested','merged','closed')),
        files jsonb NOT NULL DEFAULT '[]', base_version integer NOT NULL, reviewer_id text REFERENCES users(id), created_at bigint NOT NULL)`,
      `CREATE TABLE project_files (project_id text NOT NULL REFERENCES projects(id), path text NOT NULL, content text NOT NULL,
        version integer NOT NULL DEFAULT 1, updated_at bigint NOT NULL, PRIMARY KEY(project_id,path))`,
      `CREATE TABLE releases (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), version text NOT NULL,
        notes text NOT NULL, manifest jsonb NOT NULL, files jsonb NOT NULL, created_by text NOT NULL REFERENCES users(id),
        created_at bigint NOT NULL, UNIQUE(project_id,version))`,
      `CREATE TABLE project_versions (project_id text PRIMARY KEY REFERENCES projects(id), version integer NOT NULL DEFAULT 0)`,
      `CREATE TABLE invites (hash text PRIMARY KEY, created_by text NOT NULL REFERENCES users(id), expires_at bigint NOT NULL, used_by text REFERENCES users(id))`,
    ];
    for (const statement of statements) {
      for (const part of statement.split(';').filter(x => x.trim())) await tx.query(part);
    }
    await tx.query('INSERT INTO migrations VALUES (1,$1)', [Date.now()]);
  });
}
