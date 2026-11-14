import type {FastifyInstance} from 'fastify';
import type {Database,SQL} from './db.ts';
import type {Register} from './source-routes.ts';
import {admin,event,member,ownedWork,type Actor} from './model.ts';
import {digest,id,Problem,token} from './security.ts';
import {object,text,choice,generation} from './contracts.ts';
import {readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {notify} from './notifications.ts';

export function registerManagedHosts(app:FastifyInstance,route:Register,db:Database,options:{origin:string;dataDir?:string}){
 const authorize=async(tx:SQL,a:Actor,req:any)=>{if(a.agentId)await ownedWork(tx,a,req.params.id,req.body?.generation??Number(req.headers['x-work-generation']));else{await admin(tx,a,req.params.id);await member(tx,a,req.params.id,true);}};
 route('GET','/projects/:id/managed-hosts','Подключённые серверы, версии и команды',null,async(tx,a,req)=>{
  await member(tx,a,req.params.id);return {hosts:(await tx.query('SELECT id,name,created_at,revoked_at,enrolled_at,hostname,last_seen_at,artifact_id,previous_artifact_id,application_state,message,logs FROM managed_hosts WHERE project_id=$1 ORDER BY created_at DESC',[req.params.id])).rows,commands:(await tx.query('SELECT id,host_id,action,artifact_id,state,message,created_at,updated_at FROM host_commands WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows};
 });
 route('POST','/projects/:id/managed-hosts','Подключить сервер к управлению проектом',object({name:text(100)}),async(tx,a,req)=>{
  await admin(tx,a,req.params.id);await member(tx,a,req.params.id,true);const raw=token(),host=id();
  await tx.query('INSERT INTO managed_hosts (id,project_id,name,token_hash,created_by,created_at,enroll_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[host,req.params.id,req.body.name,digest(raw),a.userId,Date.now(),Date.now()+3600000]);
  await event(tx,a,req.params.id,'host.created','Выдана команда подключения сервера',{host_id:host});
  return {id:host,command:`curl -fsS '${options.origin}/host-connect.sh' -o /tmp/d2d-host-connect.sh && D2D_URL='${options.origin}' D2D_HOST_ID='${host}' D2D_HOST_TOKEN='${raw}' bash /tmp/d2d-host-connect.sh`,expires_at:Date.now()+3600000};
 },{idempotent:false});
 route('POST','/projects/:id/managed-hosts/revoke','Отключить сервер и отменить ещё не начатые команды',object({host_id:text(80)}),async(tx,a,req)=>{
  await admin(tx,a,req.params.id);await tx.query('UPDATE managed_hosts SET revoked_at=$1 WHERE id=$2 AND project_id=$3',[Date.now(),req.body.host_id,req.params.id]);await tx.query("UPDATE host_commands SET state='cancelled',updated_at=$1 WHERE host_id=$2 AND project_id=$3 AND state='pending'",[Date.now(),req.body.host_id,req.params.id]);await event(tx,a,req.params.id,'host.revoked','Сервер отключён от управления');return {ok:true};
 },{authorize:async(tx,a,req)=>{await admin(tx,a,req.params.id);}});
 route('POST','/projects/:id/host-commands','Обновить, перезапустить или откатить приложение',object({host_id:text(80),action:choice('update','restart','rollback'),artifact_id:text(80),generation},['host_id','action']),async(tx,a,req)=>{
  const h=(await tx.query('SELECT * FROM managed_hosts WHERE id=$1 AND project_id=$2 AND revoked_at IS NULL',[req.body.host_id,req.params.id])).rows[0];if(!h?.enrolled_at)throw new Problem(409,'HOST_NOT_CONNECTED','Сначала выполните команду подключения сервера');
  if(Number(h.last_seen_at)<Date.now()-120000)throw new Problem(409,'HOST_OFFLINE','Нет свежей связи с сервером');
  const artifactId=req.body.action==='update'?req.body.artifact_id:req.body.action==='rollback'?h.previous_artifact_id:h.artifact_id;
  if(!artifactId)throw new Problem(422,'VERSION_REQUIRED','Нет подходящей версии для операции');
  const f=(await tx.query('SELECT * FROM artifacts WHERE id=$1 AND project_id=$2',[artifactId,req.params.id])).rows[0];if(!f||f.recipe.type==='none')throw new Problem(422,'RECIPE_REQUIRED','Выберите версию с настроенным запуском');
  const command=id();await tx.query('INSERT INTO host_commands (id,host_id,project_id,action,artifact_id,created_by,agent_id,work_generation,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[command,h.id,req.params.id,req.body.action,artifactId,a.userId,a.agentId??null,a.agentId?req.body.generation:null,Date.now()]);
  await event(tx,a,req.params.id,'host.command','Поставлена команда серверу',{command_id:command,action:req.body.action});return {id:command};
 },{authorize});
 app.get('/host-connect.sh',{schema:{hide:true}},async(_req,reply)=>reply.type('text/x-shellscript').send(await readFile(resolve('scripts/host-connect.sh'),'utf8')));
 app.get('/host-runner.py',{schema:{hide:true}},async(_req,reply)=>reply.type('text/plain').send(await readFile(resolve('scripts/host-runner.py'),'utf8')));
 async function host(tx:SQL,req:any){
  const auth=String(req.headers.authorization??'');if(!auth.startsWith('Bearer '))throw new Problem(401,'HOST_AUTH','Нужен токен сервера');
  const h=(await tx.query(`SELECT h.* FROM managed_hosts h JOIN projects p ON p.id=h.project_id JOIN members m ON m.project_id=p.id AND m.user_id=h.created_by WHERE h.id=$1 AND h.token_hash=$2 AND h.revoked_at IS NULL AND p.archived_at IS NULL AND m.role='admin'`,[req.params.id,digest(auth.slice(7))])).rows[0];
  if(!h)throw new Problem(401,'HOST_AUTH','Сервер отключён или доступ отозван');
  if(!h.enrolled_at&&Number(h.enroll_expires_at)<Date.now())throw new Problem(401,'HOST_ENROLL_EXPIRED','Команда подключения истекла');
  if(h.machine_id&&h.machine_id!==req.headers['x-d2d-machine'])throw new Problem(403,'HOST_MACHINE','Команда закреплена за другим сервером');return h;
 }
 const safe=(v:string)=>v.replace(/(Bearer\s+|token[=: ]+|password[=: ]+|secret[=: ]+)[^\s]+/gi,'$1[скрыто]');
 const machine={...text(128),pattern:'^[a-f0-9]{32,128}$'};
 app.post('/api/hosts/:id/poll',{schema:{hide:true,body:object({machine_id:machine,hostname:{...text(100),pattern:'^[a-zA-Z0-9._-]+$'},state:choice('healthy','unhealthy','unknown'),artifact_id:text(80,0),message:text(1000,0),logs:text(16000,0)},['machine_id','hostname','state'])}},async(req:any)=>db.transaction(async tx=>{
  await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');const h=await host(tx,req),b=req.body;
  if(h.machine_id&&h.machine_id!==b.machine_id)throw new Problem(403,'HOST_MACHINE','Другой сервер');
  // Health messages are limited; no environment or token-bearing command lines are requested.
  await tx.query('UPDATE managed_hosts SET machine_id=$1,hostname=$2,enrolled_at=COALESCE(enrolled_at,$3),last_seen_at=$3,application_state=$4,message=$5,logs=$6 WHERE id=$7',[b.machine_id,b.hostname,Date.now(),b.state,safe(b.message??''),safe(b.logs??''),h.id]);
  if(!h.artifact_id&&b.artifact_id){const installed=(await tx.query('SELECT id FROM artifacts WHERE id=$1 AND project_id=$2',[b.artifact_id,h.project_id])).rows[0];if(installed)await tx.query('UPDATE managed_hosts SET artifact_id=$1 WHERE id=$2',[installed.id,h.id]);}
  if(h.application_state==='healthy'&&b.state==='unhealthy')await notify(tx,h.project_id,id(),'host.unhealthy',`Приложение на ${h.name} недоступно`,`project/${h.project_id}/code`,'');
  let command:any=(await tx.query("SELECT * FROM host_commands WHERE host_id=$1 AND state IN ('pending','running') ORDER BY created_at LIMIT 1",[h.id])).rows[0];
  if(command){
   try{const actor:Actor={id:command.agent_id??command.created_by,userId:command.created_by,name:'Управление сервером',role:'member',scopes:['read','write'],...(command.agent_id?{agentId:command.agent_id,projectId:h.project_id}:{})};if(actor.agentId){const g=(await tx.query('SELECT * FROM agents WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2',[actor.agentId,Date.now()])).rows[0];if(!g||!g.scopes.includes('write'))throw new Error('revoked');await ownedWork(tx,actor,h.project_id,command.work_generation);}else await admin(tx,actor,h.project_id);}
   catch{await tx.query("UPDATE host_commands SET state='cancelled',message='Доступ инициатора отозван',updated_at=$1 WHERE id=$2",[Date.now(),command.id]);command=null;}
  }
  if(!command)return {project_id:h.project_id,command:null};
  const lease=token();await tx.query("UPDATE host_commands SET state='running',lease_token_hash=$1,lease_expires_at=$2,updated_at=$3 WHERE id=$4",[digest(lease),Date.now()+3600000,Date.now(),command.id]);
  const f=(await tx.query('SELECT id,sha256,recipe FROM artifacts WHERE id=$1 AND project_id=$2',[command.artifact_id,h.project_id])).rows[0];
  return {project_id:h.project_id,command:{id:command.id,action:command.action,lease,artifact:f}};
 }));
 app.get('/api/hosts/:id/archive',{schema:{hide:true}},async(req:any,reply)=>{
  const f=await db.transaction(async tx=>{const h=await host(tx,req),q=new URL(req.url,'http://local').searchParams,c=(await tx.query("SELECT a.* FROM host_commands c JOIN artifacts a ON a.id=c.artifact_id WHERE c.id=$1 AND c.host_id=$2 AND c.state='running' AND c.lease_token_hash=$3 AND c.lease_expires_at>$4",[q.get('command'),h.id,digest(String(req.headers['x-d2d-lease']??'')),Date.now()])).rows[0];if(!c)throw new Problem(403,'COMMAND_EXPIRED','Команда недействительна');return c;});return reply.type('application/zip').send(createReadStream(resolve(options.dataDir??'.d2d','blobs',f.sha256+'.zip')));
 });
 app.post('/api/hosts/:id/result',{schema:{hide:true,body:object({command_id:text(80),lease:text(200),state:choice('succeeded','failed'),message:text(1000,0)})}},async(req:any)=>db.transaction(async tx=>{
  await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');const h=await host(tx,req),b=req.body,c=(await tx.query('SELECT * FROM host_commands WHERE id=$1 AND host_id=$2',[b.command_id,h.id])).rows[0];
  if(!c||c.lease_token_hash!==digest(b.lease))throw new Problem(403,'COMMAND_EXPIRED','Команда недействительна');
  if(['succeeded','failed'].includes(c.state)){if(c.state!==b.state)throw new Problem(409,'COMMAND_TERMINAL','Результат уже сохранён');return {ok:true};}
  if(c.state!=='running')throw new Problem(409,'COMMAND_CANCELLED','Команда отменена');
  await tx.query('UPDATE host_commands SET state=$1,message=$2,updated_at=$3 WHERE id=$4',[b.state,safe(b.message),Date.now(),c.id]);
  if(b.state==='succeeded'&&c.action!=='restart')await tx.query('UPDATE managed_hosts SET previous_artifact_id=CASE WHEN artifact_id IS DISTINCT FROM $1 THEN artifact_id ELSE previous_artifact_id END,artifact_id=$1 WHERE id=$2',[c.artifact_id,h.id]);
  await notify(tx,h.project_id,c.id,'host.result',`${h.name}: ${b.state==='succeeded'?'операция выполнена':'ошибка операции'}`,`project/${h.project_id}/code`,'');return {ok:true};
 }));
}
