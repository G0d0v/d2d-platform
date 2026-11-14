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
}
export async function currentWork(tx: SQL, projectId: string) {
  return (await tx.query(`SELECT w.*, u.display_name AS owner_name, u.login AS owner_login FROM work_sessions w
    JOIN users u ON u.id=w.owner_id WHERE w.project_id=$1 AND w.state IN ('active','paused','review') AND w.expires_at>$2`, [projectId, Date.now()])).rows[0] ?? null;
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
export async function listProjects(tx: SQL, actor: Actor): Promise<Row[]> {
  const params: any[] = [actor.userId];
  const scope = actor.agentId ? ' AND p.id=$2' : '';
  if (actor.agentId) params.push(actor.projectId);
  const projects = (await tx.query(`SELECT p.*, m.role AS member_role,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id=p.id AND t.status<>'done') AS open_tasks,
    (SELECT count(*)::int FROM changes c WHERE c.project_id=p.id AND c.state IN ('open','approved','changes_requested')) AS open_changes,
    (SELECT count(*)::int FROM members mm WHERE mm.project_id=p.id) AS member_count
    FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=$1${scope} ORDER BY p.created_at DESC`, params)).rows;
  return Promise.all(projects.map(async p => ({ ...p, work: await currentWork(tx, p.id) })));
}
