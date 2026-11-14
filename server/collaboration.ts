import type {FastifyInstance} from 'fastify';
import type {Database,SQL} from './db.ts';
import type {Register} from './source-routes.ts';
import type {Forgejo} from './forgejo.ts';
import {authenticate,human} from './auth.ts';
import {event,member,ownedWork,type Actor} from './model.ts';
import {notify} from './notifications.ts';
import {id,digest,Problem} from './security.ts';
import {object,text,choice,integer,generation} from './contracts.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {parseDiff} from '../web/src/git-diff.ts';

export function registerCollaboration(app:FastifyInstance,route:Register,db:Database,options:{dataDir?:string;git?:Forgejo}){
 const blobs=resolve(options.dataDir??'.d2d','discussion-files');
 const query=(req:any)=>new URL(req.url,'http://local').searchParams;
 const page=(req:any)=>{const value=query(req).get('page')??'1';if(!/^[1-9][0-9]{0,5}$/.test(value))throw new Problem(422,'VALIDATION_ERROR','Неверный номер страницы');return Number(value);};
 const authorize=async(tx:SQL,a:Actor,req:any)=>{await member(tx,a,req.params.id,true);if(a.agentId)await ownedWork(tx,a,req.params.id,Number(req.headers['x-work-generation']??req.body?.generation));};
 async function subject(tx:SQL,a:Actor,project:string,type:string,subjectId:string){
  await member(tx,a,project);
  if(type==='task'){const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2',[subjectId,project])).rows[0];if(!task)throw new Problem(404,'NOT_FOUND','Задача не найдена');return task;}
  if(type!=='pull'||!/^\d{1,10}$/.test(subjectId)||Number(subjectId)<1)throw new Problem(422,'INVALID_SUBJECT','Укажите задачу или запрос изменений');
  if(!options.git)throw new Problem(503,'GIT_NOT_CONFIGURED','Git не настроен');
  return options.git.json(`/repos/${options.git.repo(project)}/pulls/${Number(subjectId)}`);
 }
 route('GET','/projects/:id/comments','Обсуждение задачи или запроса изменений, по 50 сообщений',null,async(tx,a,req)=>{
  const q=query(req),type=q.get('type')??'',target=q.get('subject')??'';const entity=await subject(tx,a,req.params.id,type,target),n=page(req);
  const params=[req.params.id,type,target],total=Number((await tx.query('SELECT count(*)::int AS n FROM comments WHERE project_id=$1 AND subject_type=$2 AND subject_id=$3',params)).rows[0].n);
  return {data:(await tx.query(`SELECT c.*,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'filename',f.filename,'bytes',f.bytes)),'[]') FROM discussion_files f WHERE f.comment_id=c.id) AS attachments FROM comments c WHERE c.project_id=$1 AND c.subject_type=$2 AND c.subject_id=$3 ORDER BY c.created_at,c.id LIMIT 50 OFFSET $4`,[...params,(n-1)*50])).rows,pagination:{page:n,total,page_size:50},head_sha:type==='pull'?entity.head.sha:null};
 });
 route('POST','/projects/:id/comments','Добавить комментарий, ответ или обсуждение строки diff',object({type:choice('task','pull'),subject:text(80),body:text(10000),parent_id:text(80),file_path:text(1000),head_sha:{...text(64),pattern:'^[a-f0-9]{40,64}$'},line:integer(1,2147483647),side:choice('before','after'),attachments:{type:'array',items:text(80),maxItems:10,uniqueItems:true},generation},['type','subject','body']),async(tx,a,req)=>{
  const b=req.body,entity=await subject(tx,a,req.params.id,b.type,b.subject),now=Date.now(),comment=id();
  let parent:any;
  if(b.parent_id){parent=(await tx.query('SELECT * FROM comments WHERE id=$1 AND project_id=$2 AND subject_type=$3 AND subject_id=$4',[b.parent_id,req.params.id,b.type,b.subject])).rows[0];if(!parent)throw new Problem(404,'NOT_FOUND','Сообщение для ответа не найдено');}
  const inlineFields=[b.file_path,b.head_sha,b.line,b.side];
  if(inlineFields.some(Boolean)){
   if(b.type!=='pull'||inlineFields.some(v=>!v))throw new Problem(422,'INLINE_CONTEXT','Для строки нужны файл, коммит, номер и сторона diff');
   if(entity.head.sha!==b.head_sha)throw new Problem(409,'GIT_CHANGED','Изменения обновились. Откройте новый diff');
   const r=await options.git!.request(`/repos/${options.git!.repo(req.params.id)}/pulls/${Number(b.subject)}.diff`),files=parseDiff(await r.text());
   if(!files.some(f=>f.name===b.file_path&&f.lines.some(l=>(b.side==='before'?l.old:l.next)===b.line)))throw new Problem(422,'INLINE_CONTEXT','Этой строки нет в выбранном diff');
  }
  const files=b.attachments??[];
  for(const fileId of files){const f=(await tx.query('SELECT id FROM discussion_files WHERE id=$1 AND project_id=$2 AND author_id=$3 AND comment_id IS NULL',[fileId,req.params.id,a.id])).rows[0];if(!f)throw new Problem(422,'ATTACHMENT_INVALID','Вложение не принадлежит этому сообщению или проекту');}
  await tx.query('INSERT INTO comments (id,project_id,subject_type,subject_id,author_id,author_user_id,author_name,body,parent_id,file_path,head_sha,line,side,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)',[comment,req.params.id,b.type,b.subject,a.id,a.userId,a.name,b.body,b.parent_id??null,b.file_path??null,b.head_sha??null,b.line??null,b.side??null,now]);
  for(const f of files)await tx.query('UPDATE discussion_files SET comment_id=$1 WHERE id=$2',[comment,f]);
  const mentions=[...String(b.body).matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})/g)].map(m=>m[1].toLowerCase());
  const mentioned=mentions.length?(await tx.query('SELECT id FROM users WHERE login=ANY($1::text[])',[mentions])).rows.map(x=>x.id):[];
  const participants=(await tx.query('SELECT DISTINCT author_user_id AS id FROM comments WHERE project_id=$1 AND subject_type=$2 AND subject_id=$3',[req.params.id,b.type,b.subject])).rows.map(x=>x.id);
  if(b.type==='task')participants.push(entity.created_by);else{const author=(await tx.query('SELECT author_user_id FROM git_changes WHERE project_id=$1 AND number=$2',[req.params.id,Number(b.subject)])).rows[0];if(author)participants.push(author.author_user_id);}
  if(parent)participants.push(parent.author_user_id);
  await notify(tx,req.params.id,comment,'comment',`${a.name}: ${b.body.slice(0,160)}`,`project/${req.params.id}/${b.type==='pull'?'git/pulls':'tasks'}?discussion=${encodeURIComponent(b.subject)}`,a.userId,[...new Set([...participants,...mentioned])]);
  await event(tx,a,req.params.id,'discussion.created','Добавлен комментарий',{comment_id:comment,type:b.type,subject:b.subject});return {id:comment};
 },{authorize});
 route('POST','/projects/:id/comments/update','Редактировать свой комментарий или отметить обсуждение решённым',object({comment_id:text(80),body:text(10000),resolved:{type:'boolean'},generation},['comment_id']),async(tx,a,req)=>{
  const c=(await tx.query('SELECT * FROM comments WHERE id=$1 AND project_id=$2',[req.body.comment_id,req.params.id])).rows[0];if(!c)throw new Problem(404,'NOT_FOUND','Сообщение не найдено');
  if(req.body.body!==undefined){if(c.author_id!==a.id)throw new Problem(403,'FORBIDDEN','Редактировать сообщение может его автор');await tx.query('UPDATE comments SET body=$1,revisions=$2,updated_at=$3 WHERE id=$4',[req.body.body,JSON.stringify([...c.revisions,{body:c.body,updated_at:c.updated_at}]),Date.now(),c.id]);}
  if(req.body.resolved!==undefined)await tx.query('UPDATE comments SET resolved=$1,updated_at=$2 WHERE id=$3',[req.body.resolved,Date.now(),c.id]);return {ok:true};
 },{authorize});
 route('POST','/projects/:id/discussion-files','Загрузить вложение обсуждения (до 4 МиБ)',object({filename:text(200),content:text(5592408),generation},['filename','content']),async(tx,a,req)=>{
  const name=req.body.filename;if(/[\\/\x00-\x1f]/.test(name)||/^\.env|\.(pem|key|p12|pfx)$/i.test(name))throw new Problem(422,'UNSAFE_FILE','Уберите секреты и пути из имени файла');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(req.body.content))throw new Problem(422,'INVALID_FILE','Неверное содержимое вложения');
  const bytes=Buffer.from(req.body.content,'base64');if(!bytes.length||bytes.length>4*1024*1024)throw new Problem(422,'FILE_SIZE','Вложение должно быть от 1 байта до 4 МиБ');
  let mime='';if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';else if(bytes.subarray(0,5).toString()==='%PDF-')mime='application/pdf';else if(!bytes.includes(0)&&/\.(txt|md|log|json|csv|ts|tsx|js|py|yml|yaml|sh|css|html)$/i.test(name))mime='text/plain';
  if(!mime)throw new Problem(422,'FILE_TYPE','Поддерживаются PNG, JPEG, PDF и текстовые файлы');
  if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8')))throw new Problem(422,'UNSAFE_FILE','Приватный ключ нельзя прикладывать к обсуждению');
  await mkdir(blobs,{recursive:true,mode:0o700});const sha=digest(bytes.toString('base64')),file=id();try{await writeFile(resolve(blobs,sha),bytes,{mode:0o600,flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  await tx.query('INSERT INTO discussion_files (id,project_id,author_id,filename,mime,sha256,bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[file,req.params.id,a.id,name,mime,sha,bytes.length,Date.now()]);return {id:file,filename:name,bytes:bytes.length};
 },{authorize,bodyLimit:6*1024*1024});
 app.get<{Params:{id:string}}>('/api/v1/discussion-files/:id/download',{schema:{hide:true}},async(req,reply)=>{
  const f=await db.transaction(async tx=>{const a=await authenticate(tx,req,false),f=(await tx.query('SELECT * FROM discussion_files WHERE id=$1',[req.params.id])).rows[0];if(!f)throw new Problem(404,'NOT_FOUND','Вложение не найдено');await member(tx,a,f.project_id);if(!f.comment_id&&f.author_id!==a.id)throw new Problem(404,'NOT_FOUND','Вложение не найдено');return f;});
  return reply.type(f.mime).header('Content-Disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(f.filename)}`).send(createReadStream(resolve(blobs,f.sha256)));
 });
 route('GET','/me/notifications','Личные уведомления только из доступных проектов',null,async(tx,a,req)=>{
  human(a);const n=page(req),unread=query(req).get('unread')==='true',where=`n.user_id=$1 AND p.archived_at IS NULL ${unread?'AND n.read_at IS NULL':''}`;
  const join='FROM notifications n JOIN members m ON m.project_id=n.project_id AND m.user_id=n.user_id JOIN projects p ON p.id=n.project_id';
  return {data:(await tx.query(`SELECT n.*,p.name AS project_name ${join} WHERE ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT 50 OFFSET $2`,[a.userId,(n-1)*50])).rows,unread:Number((await tx.query(`SELECT count(*)::int AS n ${join} WHERE n.user_id=$1 AND p.archived_at IS NULL AND n.read_at IS NULL`,[a.userId])).rows[0].n),pagination:{page:n,page_size:50,total:Number((await tx.query(`SELECT count(*)::int AS n ${join} WHERE ${where}`,[a.userId])).rows[0].n)}};
 });
 route('POST','/me/notifications/read','Отметить свои уведомления прочитанными',object({id:text(80),all:{type:'boolean'},before:integer(0,Number.MAX_SAFE_INTEGER)},[]),async(tx,a,req)=>{
  human(a);if(!req.body.id&&!req.body.all)throw new Problem(422,'VALIDATION_ERROR','Выберите уведомление');
  await tx.query(`UPDATE notifications n SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL ${req.body.id?'AND id=$3':'AND created_at<=$3'} AND EXISTS(SELECT 1 FROM members m WHERE m.project_id=n.project_id AND m.user_id=$2)`,[Date.now(),a.userId,req.body.id??req.body.before??Date.now()]);return {ok:true};
 },{authorize:async(_tx,a)=>{human(a);}});
}
