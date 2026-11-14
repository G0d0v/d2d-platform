import type { SQL, Row } from './db.ts';
import { id, Problem } from './security.ts';

export interface Actor { id: string; userId: string; name: string; role: string; agentId?: string; projectId?: string; scopes: string[]; csrf?: string; sessionHash?: string; }
export async function event(tx: SQL, actor: Actor, projectId: string | null, kind: string, message: string, detail: any = {}) {
  await tx.query('INSERT INTO events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(), projectId, actor.id, actor.name, kind, message, JSON.stringify(detail), Date.now()]);
}
export async function member(tx: SQL, actor: Actor, projectId: string, write = false): Promise<Row> {
  if (actor.agentId && actor.projectId !== projectId) throw new Problem(404, 'NOT_FOUND', 'Проект не найден');
  const row = (await tx.query(`SELECT p.*, m.role AS member_role FROM projects p JOIN members m ON m.project_id=p.id
    WHERE p.id=$1 AND m.user_id=$2`, [projectId, actor.userId])).rows[0];
  if (!row) throw new Problem(404, 'NOT_FOUND', 'Проект не найден');
  if (write && row.archived_at) throw new Problem(409, 'PROJECT_ARCHIVED', 'Проект в архиве. Восстановите его перед изменением');
  if (write && (row.member_role === 'viewer' || (actor.agentId && !actor.scopes.includes('write'))))
    throw new Problem(403, 'FORBIDDEN', 'Недостаточно прав для изменения проекта');
  return row;
}
export async function admin(tx: SQL, actor: Actor, projectId: string) {
  const row = await member(tx, actor, projectId);
  if (actor.agentId || row.member_role !== 'admin') throw new Problem(403, 'FORBIDDEN', 'Нужны права администратора проекта');
  return row;
}
export async function lockProject(tx: SQL, projectId: string) {
  await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
  await tx.query(`UPDATE work_sessions SET state='expired' WHERE project_id=$1 AND state IN ('active','paused','review') AND expires_at<=$2`, [projectId, Date.now()]);
  await tx.query(`UPDATE work_sessions SET state='expired' WHERE project_id=$1 AND state IN ('active','paused','review') AND executor_id<>owner_id
    AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id=executor_id AND a.revoked_at IS NULL AND a.expires_at>$2)`, [projectId,Date.now()]);
}
export async function currentWork(tx: SQL, projectId: string) {
  return (await tx.query(`SELECT w.*, u.display_name AS owner_name, u.login AS owner_login FROM work_sessions w
    JOIN users u ON u.id=w.owner_id WHERE w.project_id=$1 AND w.state IN ('active','paused','review') AND w.expires_at>$2
    AND (w.executor_id=w.owner_id OR EXISTS (SELECT 1 FROM agents a WHERE a.id=w.executor_id AND a.revoked_at IS NULL AND a.expires_at>$2))`, [projectId, Date.now()])).rows[0] ?? null;
}
export async function ownedWork(tx: SQL, actor: Actor, projectId: string, generation?: number) {
  await member(tx, actor, projectId, true);
  await lockProject(tx, projectId);
  const work = await currentWork(tx, projectId);
  if (!work) throw new Problem(409, 'LEASE_EXPIRED', 'Нет действующей рабочей сессии. Возьмите проект в разработку');
  if (work.executor_id !== actor.id) throw new Problem(409, 'PROJECT_BUSY', 'Проект занят другим исполнителем', { owner: work.owner_name });
  if (generation === undefined || work.generation !== generation) throw new Problem(409, 'STALE_LEASE', 'Рабочая сессия изменилась. Получите актуальный контекст');
  return work;
}
type ProjectOptions={page?:number;q?:string;state?:string;archived?:boolean;mine?:boolean};
async function queryProjects(tx:SQL,actor:Actor,options:ProjectOptions={}) {
  const params: any[] = [actor.userId];
  const conditions=['m.user_id=$1'];
  const value=(v:any)=>{params.push(v);return '$'+params.length;};
  if(actor.agentId)conditions.push(`p.id=${value(actor.projectId)}`);
  conditions.push(`(p.archived_at IS NOT NULL)=${value(!!options.archived)}`);
  if(options.q)conditions.push(`(p.name ILIKE ${value('%'+options.q+'%')} OR p.description ILIKE $${params.length} OR p.slug ILIKE $${params.length})`);
  if(options.state==='free')conditions.push('w.id IS NULL');
  if(options.state==='busy')conditions.push('w.id IS NOT NULL');
  if(options.mine)conditions.push(`w.executor_id=${value(actor.id)}`);
  const now=value(Date.now());
  const limit=options.page?`LIMIT 50 OFFSET ${value((options.page-1)*50)}`:'';
  const result = (await tx.query(`WITH matched AS (SELECT p.*, m.role AS member_role, row_to_json(w) AS work,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.status<>'done' AND t.archived_at IS NULL) AS open_tasks,
    (SELECT count(*)::int FROM changes c WHERE c.project_id=p.id AND c.state IN ('open','approved','changes_requested')) AS open_changes,
    (SELECT count(*)::int FROM members mm WHERE mm.project_id=p.id) AS member_count
    FROM projects p JOIN members m ON m.project_id=p.id LEFT JOIN LATERAL (SELECT ws.*,u.display_name AS owner_name,u.login AS owner_login FROM work_sessions ws JOIN users u ON u.id=ws.owner_id
      WHERE ws.project_id=p.id AND ws.state IN ('active','paused','review') AND ws.expires_at>${now} AND (ws.executor_id=ws.owner_id OR EXISTS (SELECT 1 FROM agents a WHERE a.id=ws.executor_id AND a.revoked_at IS NULL AND a.expires_at>${now}))) w ON true
    WHERE ${conditions.join(' AND ')}) SELECT (SELECT COALESCE(json_agg(page),'[]'::json) FROM (SELECT * FROM matched ORDER BY created_at DESC,id ${limit}) page) AS data,(SELECT count(*)::int FROM matched) AS total`,params)).rows[0];
  return result;
}
export async function listProjects(tx:SQL,actor:Actor,options:ProjectOptions={}):Promise<Row[]>{return (await queryProjects(tx,actor,{...options,page:undefined})).data;}
export async function projectPage(tx:SQL,actor:Actor,options:ProjectOptions={}){const r=await queryProjects(tx,actor,{...options,page:options.page??1});return {data:r.data,pagination:{page:options.page??1,page_size:50,total:r.total}};}

export async function lastHandoff(tx: SQL, projectId: string) {
  return (await tx.query(`SELECT w.id,w.summary,w.state,w.started_at,u.display_name AS author FROM work_sessions w JOIN users u ON u.id=w.owner_id
    WHERE w.project_id=$1 AND w.summary<>'' AND w.state IN ('finished','transferred') ORDER BY w.generation DESC LIMIT 1`,[projectId])).rows[0] ?? null;
}
