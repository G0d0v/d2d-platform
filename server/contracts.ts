export const text = (maxLength = 500, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(minLength ? { pattern: '\\S' } : {}) });
export const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
export const choice = (...values: string[]) => ({ type: 'string', enum: values });
export const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
export const generation = integer(1, 2147483647);
export const errorSchema = {
  type: 'object', required: ['error'], properties: {
    error: { type: 'object', required: ['code', 'message', 'request_id', 'retryable'], properties: {
      code: text(), message: text(2000), request_id: text(), retryable: { type: 'boolean' }, details: {},
    } },
  },
};
const responseObject = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
const timestamp = { type: 'integer', format: 'int64' };
const userSchema = responseObject({ id: text(), login: text(), display_name: text(), role: text() });
const workSchema = responseObject({ id: text(), project_id: text(), owner_id: text(), owner_name: text(), executor_id: text(),
  generation, note: text(2000), state: choice('active', 'paused', 'review'), branch: text(),
  started_at: timestamp, expires_at: timestamp, heartbeat_at: timestamp, summary: text(10000, 0) });
const nullableWork = { ...workSchema, nullable: true };
const projectSchema = responseObject({ id: text(), slug: text(), name: text(), description: text(2000, 0), member_role: choice('admin', 'developer', 'viewer'), work: nullableWork });
const taskSchema = responseObject({ id: text(), project_id: text(), title: text(200), description: text(10000, 0), status: choice('todo', 'in_progress', 'review', 'done'), priority: choice('low', 'normal', 'high'), version: generation, created_at: timestamp, updated_at: timestamp });
const arrayOf = (items: unknown) => ({ type: 'array', items });
const paginationSchema = responseObject({ page: integer(1, 1000000), page_size: integer(1, 50), total: integer(0, 2147483647) });
const paginated = (item: unknown) => responseObject({ data: arrayOf(item), pagination: paginationSchema });
const auditSchema = responseObject({ id: text(), actor_id: text(), actor_name: text(), kind: text(), message: text(5000), created_at: timestamp, detail: { type: 'object', additionalProperties: true } });
export function responseSchemaFor(method: string, path: string): any {
  if (['/me/work','/me/navigation','/me/attention','/me/security','/team'].includes(path)||path.endsWith('/source')||path.startsWith('/artifacts/')) return {type:'object',additionalProperties:true};
  if (path === '/status') return responseObject({ registration: choice('open', 'invite'), setup: { type: 'boolean' } });
  if (['/auth/login', '/auth/register', '/auth/recover'].includes(path)) return responseObject({ user: userSchema, csrf: text(), recovery_code: text() }, path === '/auth/login' ? ['user', 'csrf'] : ['user', 'csrf', 'recovery_code']);
  if (path === '/me') return responseObject({ user: userSchema, scopes: arrayOf(text()), csrf: text(), agent_id: text() }, ['user', 'scopes']);
  if (method === 'GET' && path === '/projects') return paginated(projectSchema);
  if (method === 'POST' && path === '/projects') return responseObject({ project: projectSchema });
  if (method === 'GET' && path === '/projects/:id') return responseObject({ project: projectSchema, tasks: arrayOf(taskSchema), members: arrayOf(responseObject({ id: text(), login: text(), display_name: text(), role: text() })),
    events: arrayOf(auditSchema), handoffs: arrayOf({ type: 'object', additionalProperties: true }), agents: arrayOf({ type: 'object', additionalProperties: true }) });
  if (path === '/projects/:id/tasks') return method === 'GET' ? paginated(taskSchema) : responseObject({ task: taskSchema });
  if (path === '/tasks/:id') return responseObject({ task: taskSchema });
  if (path === '/projects/:id/audit-events') return paginated(auditSchema);
  if (path === '/projects/:id/work-sessions' || /^\/work-sessions\/:id\/(heartbeat|renew|state|handoff)$/.test(path)) return responseObject({ work: workSchema });
  if (path === '/projects/:id/agent-context') return responseObject({ project: responseObject({ id: text(), name: text(), description: text(2000, 0) }), work: nullableWork,
    permissions: responseObject({ role: text(), scopes: arrayOf(text()) }), capabilities: { type: 'object', additionalProperties: { type: 'boolean' } }, instructions: arrayOf(text()), tasks_url: text(), context_version: integer(0, 2147483647), observed_at: timestamp });
  if (path === '/projects/:id/agents') return responseObject({ id: text(), token: text(), expires_at: timestamp });
  if (path === '/invites') return responseObject({ invite: text(), expires_at: timestamp });
  if (path === '/capabilities') return responseObject({ api_version: text(), work_sessions: { type: 'boolean' }, tasks: { type: 'boolean' }, agents: { type: 'boolean' }, forgejo: { type: 'boolean' }, git_write: { type: 'boolean' }, reviews: { type: 'boolean' }, builds: { type: 'boolean' }, releases: { type: 'boolean' }, deployments: { type: 'boolean' }, mcp: { type: 'boolean' } });
  if (path.endsWith('/transfer-requests')) return responseObject({ id: text() });
  return responseObject({ ok: { type: 'boolean' } });
}
export interface User { id: string; login: string; display_name: string; role: string; }
export interface Work {
  id: string; project_id: string; owner_id: string; owner_name: string; executor_id: string;
  generation: number; task_id: string | null; note: string; state: string; branch: string;
  started_at: number; expires_at: number; heartbeat_at: number; summary: string;
}
export interface Project {
  id: string; slug: string; name: string; description: string; member_role: string;
  open_tasks: number; member_count: number; created_at: number; work: Work | null;
}
export interface Task {
  id: string; title: string; description: string; status: 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'normal' | 'high'; version: number; created_at: number;
}
export interface Person { id: string; login: string; display_name: string; role: string; }
export interface AuditEvent { id: string; actor_name: string; kind: string; message: string; created_at: number; }
export interface Handoff { id: string; requested_by: string; requester_name: string; note: string; state: string; }
export interface Agent { id: string; name: string; scopes: string[]; expires_at: number; revoked_at: number | null; }
export interface ProjectDetail {
  project: Project; tasks: Task[]; members: Person[]; events: AuditEvent[]; handoffs: Handoff[]; agents: Agent[];
}
