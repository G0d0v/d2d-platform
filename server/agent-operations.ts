import type {Register} from './source-routes.ts';
import type {SQL} from './db.ts';
import type {TokenVault} from './token-vault.ts';
import {human} from './auth.ts';
import {event,member,ownedWork,type Actor} from './model.ts';
import {object,text,choice,integer,generation} from './contracts.ts';
import {digest,id,Problem} from './security.ts';

export function registerAgentOperations(route:Register,{vault,origin}:{vault:TokenVault;origin:string}){
 async function owner(tx:SQL,a:Actor,agentId:string){
  human(a);const agent=(await tx.query('SELECT * FROM agents WHERE id=$1',[agentId])).rows[0];
  if(!agent||agent.owner_id!==a.userId)throw new Problem(404,'NOT_FOUND','Агент не найден');
  await member(tx,a,agent.project_id,true);
  if(agent.revoked_at||Number(agent.expires_at)<=Date.now())throw new Problem(409,'TOKEN_INACTIVE','Токен отозван или истёк');return agent;
 }
 route('POST','/agents/:id/token','Создателю: повторно показать токен агента',object({}),async(tx,a,req)=>{
  const agent=await owner(tx,a,req.params.id);
  if(!agent.token_cipher)throw new Problem(409,'TOKEN_NOT_SAVED','Старый токен хранится только как хеш. Он станет доступен после следующего API-запроса агента, либо сохраните известный токен через форму.');
  await event(tx,a,agent.project_id,'agent.token_viewed','Создатель просмотрел токен агента',{agent_id:agent.id});
  return {token:vault.open(agent.token_cipher,agent.id),expires_at:agent.expires_at};
 },{idempotent:false});
 route('POST','/agents/:id/token/save','Создателю: сохранить известный старый токен для повторного просмотра',object({token:text(200)}),async(tx,a,req)=>{
  const agent=await owner(tx,a,req.params.id);if(digest(req.body.token)!==agent.token_hash)throw new Problem(422,'TOKEN_MISMATCH','Этот токен не принадлежит выбранному агенту');
  await tx.query('UPDATE agents SET token_cipher=$1 WHERE id=$2',[vault.seal(req.body.token,agent.id),agent.id]);return {ok:true};
 },{idempotent:false});
 route('GET','/projects/:id/agent-activity','Панель агентов: связь, сессии, шаги и запросы остановки',null,async(tx,a,req)=>{
  await member(tx,a,req.params.id);const project=req.params.id;
  const agents=(await tx.query(`SELECT a.id,a.owner_id,a.name,a.scopes,a.created_at,a.expires_at,a.revoked_at,a.last_seen_at,u.display_name AS owner_name,(a.token_cipher IS NOT NULL) AS token_saved FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.project_id=$1 ORDER BY a.created_at DESC`,[project])).rows;
  return {agents:agents.filter(row=>!a.agentId||row.id===a.agentId),work:await tx.query("SELECT w.*,t.title AS task_title FROM work_sessions w LEFT JOIN tasks t ON t.id=w.task_id WHERE w.project_id=$1 AND w.executor_id<>w.owner_id ORDER BY w.started_at DESC LIMIT 100",[project]).then(r=>r.rows),steps:(await tx.query('SELECT s.*,g.name AS agent_name FROM agent_steps s JOIN agents g ON g.id=s.agent_id WHERE s.project_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 200',[project])).rows,stops:(await tx.query('SELECT * FROM agent_stop_requests WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[project])).rows,guide_url:`${origin}/docs/agents/context.md`};
 });
 const authorize=async(tx:SQL,a:Actor,req:any)=>{if(!a.agentId)throw new Problem(403,'AGENT_REQUIRED','Отчёт отправляет подключённый ИИ-агент');await ownedWork(tx,a,req.params.id,req.body.generation);};
 route('POST','/projects/:id/agent-steps','Агент: сохранить этап работы актуальной сессии',object({generation,state:choice('working','waiting','completed','failed','stopped'),stage:text(120),message:text(4000,0),progress:integer(0,100),commit_sha:{...text(64),pattern:'^[a-f0-9]{40,64}$'}},['generation','state','stage','message']),async(tx,a,req)=>{
  const w=await ownedWork(tx,a,req.params.id,req.body.generation),step=id();
  // Stop is acknowledged by the current agent, never inferred from an idle browser.
  const stop=(await tx.query('SELECT * FROM agent_stop_requests WHERE agent_id=$1 AND session_id=$2 AND generation=$3',[a.agentId,w.id,w.generation])).rows[0];
  if(stop&&req.body.state==='stopped')await tx.query('UPDATE agent_stop_requests SET acknowledged_at=$1 WHERE id=$2',[Date.now(),stop.id]);
  await tx.query('INSERT INTO agent_steps VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[step,req.params.id,a.agentId,w.id,w.generation,req.body.state,req.body.stage,req.body.message,req.body.progress??null,req.body.commit_sha??null,Date.now()]);
  await event(tx,a,req.params.id,'agent.step',`Агент: ${req.body.stage}`,{step_id:step,state:req.body.state});
  return {id:step,stop_requested:!!stop,session_id:w.id,generation:w.generation};
 },{authorize});
 route('POST','/projects/:id/agent-stop','Запросить остановку текущей работы агента',object({agent_id:text(80),generation}),async(tx,a,req)=>{
  human(a);const p=await member(tx,a,req.params.id,true),w=(await tx.query("SELECT * FROM work_sessions WHERE project_id=$1 AND executor_id=$2 AND generation=$3 AND state IN ('active','paused','review') AND expires_at>$4",[req.params.id,req.body.agent_id,req.body.generation,Date.now()])).rows[0];
  if(!w)throw new Problem(409,'WORK_CHANGED','Работа агента уже изменилась');if(w.owner_id!==a.userId&&p.member_role!=='admin')throw new Problem(403,'FORBIDDEN','Остановку запрашивает владелец сессии или администратор');
  await tx.query('INSERT INTO agent_stop_requests (id,project_id,agent_id,session_id,generation,requested_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(agent_id,session_id,generation) DO NOTHING',[id(),req.params.id,req.body.agent_id,w.id,w.generation,a.userId,Date.now()]);
  await event(tx,a,req.params.id,'agent.stop','Запрошена остановка агента',{agent_id:req.body.agent_id});return {ok:true};
 },{authorize:async(tx,a,req)=>{human(a);await member(tx,a,req.params.id,true);}});
}
