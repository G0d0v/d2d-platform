import type {SQL} from './db.ts';
export async function collaborationSchema(tx:SQL){
 if((await tx.query('SELECT version FROM migrations WHERE version=6')).rows.length)return;
 for(const sql of [
  'ALTER TABLE agents ADD COLUMN token_cipher text',
  `CREATE TABLE notifications (id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),project_id text NOT NULL REFERENCES projects(id),event_key text NOT NULL,kind text NOT NULL,title text NOT NULL,target text NOT NULL,created_at bigint NOT NULL,read_at bigint,UNIQUE(user_id,event_key))`,
  'CREATE INDEX notifications_user_time ON notifications(user_id,created_at DESC,id DESC)',
  `CREATE TABLE comments (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),subject_type text NOT NULL,subject_id text NOT NULL,author_id text NOT NULL,author_user_id text NOT NULL REFERENCES users(id),author_name text NOT NULL,body text NOT NULL,parent_id text REFERENCES comments(id),file_path text,head_sha text,line integer,side text,resolved boolean NOT NULL DEFAULT false,revisions jsonb NOT NULL DEFAULT '[]',created_at bigint NOT NULL,updated_at bigint NOT NULL)`,
  'CREATE INDEX comments_subject ON comments(project_id,subject_type,subject_id,created_at,id)',
  `CREATE TABLE discussion_files (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),author_id text NOT NULL,filename text NOT NULL,mime text NOT NULL,sha256 text NOT NULL,bytes integer NOT NULL,comment_id text REFERENCES comments(id),created_at bigint NOT NULL)`,
  `CREATE TABLE agent_steps (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),agent_id text NOT NULL REFERENCES agents(id),session_id text NOT NULL REFERENCES work_sessions(id),generation integer NOT NULL,state text NOT NULL,stage text NOT NULL,message text NOT NULL,progress integer,commit_sha text,created_at bigint NOT NULL)`,
  'CREATE INDEX agent_steps_project_time ON agent_steps(project_id,created_at DESC,id DESC)',
  `CREATE TABLE agent_stop_requests (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),agent_id text NOT NULL REFERENCES agents(id),session_id text NOT NULL REFERENCES work_sessions(id),generation integer NOT NULL,requested_by text NOT NULL REFERENCES users(id),created_at bigint NOT NULL,acknowledged_at bigint,UNIQUE(agent_id,session_id,generation))`,
  `CREATE TABLE managed_hosts (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),name text NOT NULL,token_hash text NOT NULL UNIQUE,created_by text NOT NULL REFERENCES users(id),created_at bigint NOT NULL,revoked_at bigint,enroll_expires_at bigint NOT NULL,enrolled_at bigint,machine_id text,hostname text,last_seen_at bigint,artifact_id text REFERENCES artifacts(id),previous_artifact_id text REFERENCES artifacts(id),application_state text NOT NULL DEFAULT 'unknown',message text NOT NULL DEFAULT '',logs text NOT NULL DEFAULT '')`,
  `CREATE TABLE host_commands (id text PRIMARY KEY,host_id text NOT NULL REFERENCES managed_hosts(id),project_id text NOT NULL REFERENCES projects(id),action text NOT NULL,artifact_id text REFERENCES artifacts(id),created_by text NOT NULL REFERENCES users(id),agent_id text REFERENCES agents(id),work_generation integer,created_at bigint NOT NULL,state text NOT NULL DEFAULT 'pending',lease_token_hash text,lease_expires_at bigint,message text NOT NULL DEFAULT '',updated_at bigint NOT NULL)`,
  `CREATE UNIQUE INDEX one_host_command ON host_commands(host_id) WHERE state IN ('pending','running')`,
  `CREATE TABLE git_ownership (project_id text NOT NULL REFERENCES projects(id),commit_sha text NOT NULL,actor_id text NOT NULL,user_id text NOT NULL REFERENCES users(id),session_id text NOT NULL,generation integer NOT NULL,created_at bigint NOT NULL,PRIMARY KEY(project_id,commit_sha))`,
  `INSERT INTO git_ownership SELECT project_id,commit_sha,created_by,created_by,'archive:'||id,0,created_at FROM artifacts WHERE commit_sha ~ '^[a-f0-9]{40,64}$' ORDER BY created_at ON CONFLICT DO NOTHING`,
 ])await tx.query(sql);
 await tx.query('INSERT INTO migrations VALUES (6,$1)',[Date.now()]);
}
