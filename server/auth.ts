import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SQL, Row } from './db.ts';
import type { Actor } from './model.ts';
import { digest, equal, id, passwordHash, passwordVerify, Problem, token } from './security.ts';

export async function authenticate(tx: SQL, req: FastifyRequest, mutation: boolean): Promise<Actor> {
  const authorization = req.headers.authorization;
  if (authorization) {
    if (!authorization.startsWith('Bearer ')) throw new Problem(401, 'UNAUTHENTICATED', 'Нужен Bearer-токен');
    const a = (await tx.query(`SELECT a.*, u.display_name, u.role FROM agents a JOIN users u ON u.id=a.owner_id
      WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>$2`, [digest(authorization.slice(7)), Date.now()])).rows[0];
    if (!a) throw new Problem(401, 'TOKEN_REVOKED', 'Токен недействителен, истёк или отозван');
    await tx.query('UPDATE agents SET last_seen_at=$1 WHERE id=$2',[Date.now(),a.id]);
    return { id: a.id, userId: a.owner_id, name: `${a.name} · ${a.display_name}`, role: a.role,
      agentId: a.id, projectId: a.project_id, scopes: a.scopes };
  }
  const raw = req.cookies.d2d_session;
  const s = raw && (await tx.query(`SELECT s.*, u.id, u.display_name, u.role FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.hash=$1 AND s.expires_at>$2`, [digest(raw), Date.now()])).rows[0];
  if (!s) throw new Problem(401, 'UNAUTHENTICATED', 'Войдите в аккаунт');
  if (mutation && !equal(String(req.headers['x-csrf-token'] ?? ''), s.csrf))
    throw new Problem(403, 'CSRF_INVALID', 'Обновите страницу и повторите действие');
  return { id: s.id, userId: s.id, name: s.display_name, role: s.role, scopes: ['read', 'write'], csrf: s.csrf, sessionHash: s.hash };
}
export function human(actor: Actor) {
  if (actor.agentId) throw new Problem(403, 'HUMAN_REQUIRED', 'Это действие доступно только человеку');
}
export const publicUser = (u: Row) => ({ id: u.id, login: u.login, display_name: u.display_name, role: u.role });
export async function newSession(tx: SQL, user: Row, reply: FastifyReply, secure: boolean) {
  const raw = token(), csrf = token();
  await tx.query('INSERT INTO sessions (hash,user_id,csrf,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)', [digest(raw), user.id, csrf, Date.now() + 7 * 86400000, Date.now()]);
  reply.setCookie('d2d_session', raw, { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: 7 * 86400 });
  return { user: publicUser(user), csrf };
}
export async function createUser(tx: SQL, body: any, registration: string) {
  const users = (await tx.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (users > 0 && registration !== 'open') {
    const invitation = body.invite && (await tx.query('SELECT * FROM invites WHERE hash=$1 AND used_by IS NULL AND expires_at>$2', [digest(body.invite), Date.now()])).rows[0];
    if (!invitation) throw new Problem(403, 'INVITE_REQUIRED', 'Для регистрации нужно действующее приглашение');
  }
  const recovery = token();
  const user = { id: id(), login: body.login.toLowerCase(), display_name: body.display_name, role: users === 0 ? 'owner' : 'member' };
  await tx.query('INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user.id, user.login, user.display_name, await passwordHash(body.password), digest(recovery), user.role, Date.now()]);
  if (body.invite) {
    const invite = (await tx.query('UPDATE invites SET used_by=$1 WHERE hash=$2 AND used_by IS NULL RETURNING *', [user.id, digest(body.invite)])).rows[0];
    if (invite?.project_id) await tx.query('INSERT INTO members VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [invite.project_id,user.id,invite.member_role]);
  }
  return { user, recovery };
}
export async function verifyLogin(tx: SQL, login: string, password: string) {
  const u = (await tx.query('SELECT * FROM users WHERE login=$1', [login.toLowerCase()])).rows[0];
  // Perform a password hash even for an unknown login to avoid a cheap account oracle.
  const valid = u ? await passwordVerify(u.password_hash, password) : (await passwordHash(password), false);
  if (!valid) throw new Problem(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
  return u;
}
