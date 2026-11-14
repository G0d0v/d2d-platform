import { mkdir,readFile,rename,rm } from 'node:fs/promises';
import { createReadStream,createWriteStream } from 'node:fs';
import { Transform,type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance,FastifyReply,FastifyRequest,HTTPMethods } from 'fastify';
import type { Database,SQL } from './db.ts';
import { authenticate } from './auth.ts';
import { currentWork,event,member,ownedWork,sourceWriter,type Actor } from './model.ts';
import { digest,id,Problem,token } from './security.ts';
import { choice,integer,object,text } from './contracts.ts';
import { inspectArchive,archiveFileStream } from './archives.ts';
import type {Forgejo} from './forgejo.ts';
import {importSource} from './git-source.ts';

export type Register=(method:HTTPMethods,path:string,summary:string,body:any,handler:(tx:SQL,a:Actor,req:any,reply:FastifyReply)=>Promise<any>,settings?:{idempotent?:boolean;bodyLimit?:number})=>void;
export function registerSourceRoutes(app:FastifyInstance,route:Register,db:Database,options:{dataDir?:string;origin?:string;git?:Forgejo}) {
  const blobs=resolve(options.dataDir??'.d2d','blobs');
  const blob=(sha:string)=>resolve(blobs,sha+'.zip');
  type Upload={temp:string;sha:string;bytes:number;scan:Awaited<ReturnType<typeof inspectArchive>>};
  const uploads=new WeakMap<object,string>();
  app.addHook('onResponse',async req=>{const temp=uploads.get(req);if(temp)await rm(temp,{force:true});});
  app.addContentTypeParser('application/zip',async(req:FastifyRequest,body:Readable)=>{
    const match=/^\/api\/v1\/projects\/([^/?]+)\/source(?:\?.*)?$/.exec(req.url);
    if(req.method!=='POST'||!match)throw new Problem(415,'ZIP_REQUIRED','ZIP поддерживается только при загрузке исходников');
    // Authorize before receiving bytes, then recheck inside the mutation after upload.
    await db.transaction(async tx=>{const a=await authenticate(tx,req,true);await sourceWriter(tx,a,match[1],Number(req.headers['x-work-generation']));});
    await mkdir(blobs,{recursive:true,mode:0o700});const temp=resolve(blobs,id()+'.upload');uploads.set(req,temp);
    const hash=createHash('sha256');let bytes=0;
    try{
      await pipeline(body,new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;hash.update(chunk);done(null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
      const scan=await inspectArchive(temp);
      return {temp,sha:hash.digest('hex'),bytes,scan} satisfies Upload;
    }catch(e){await rm(temp,{force:true});throw e;}
  });
  route('GET','/projects/:id/source','Версии загруженного исходного проекта',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);return {artifacts:(await tx.query('SELECT * FROM artifacts WHERE project_id=$1 ORDER BY created_at DESC,id DESC',[req.params.id])).rows,
      installations:(await tx.query('SELECT id,artifact_id,state,host,message,created_at,updated_at FROM installations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows};
  });
  route('POST','/projects/:id/source','Загрузить ZIP исходного проекта потоком без лимита размера',null,async(tx,a,req)=>{
    await sourceWriter(tx,a,req.params.id,Number(req.headers['x-work-generation']));
    const w=await currentWork(tx,req.params.id);if(w) await ownedWork(tx,a,req.params.id,Number(req.headers['x-work-generation']));
    const upload=req.body as Upload;if(!upload?.temp||uploads.get(req)!==upload.temp)throw new Problem(415,'ZIP_REQUIRED','Выберите ZIP-архив проекта');
    const stored=await storeSource(tx,a,req.params.id,blobs,upload,String(req.headers['x-filename']??'project.zip'));
    if(!options.git)return stored;
    let sync:any;
    // Archive storage remains usable during a Git outage; never discard an accepted ZIP.
    try{
      const repo=await options.git.ensure(req.params.id);
      if(repo.empty||w){
        const branch=repo.empty?'main':w.branch;
        const commit=await importSource(options.git,req.params.id,stored.artifact,blob(stored.artifact.sha256),resolve(options.dataDir??'.d2d','git-work'),branch,a,`Загрузка ${stored.artifact.filename}`);
        await tx.query('UPDATE artifacts SET commit_sha=$1 WHERE id=$2',[commit,stored.artifact.id]);stored.artifact.commit_sha=commit;
        await event(tx,a,req.params.id,'git.import','Загруженный архив записан в Git',{artifact_id:stored.artifact.id,commit_sha:commit,branch});sync={commit_sha:commit,branch};
      }else sync={pending:true,message:'Архив сохранён. Для записи следующей версии в Git возьмите проект в разработку и нажмите «Записать ZIP в Git».'};
    }catch(e){sync={error:true,message:e instanceof Problem?e.message:'Архив сохранён, но Git не подтвердил импорт. Проверьте Git перед повтором.'};}
    return {...stored,git:sync};
  },{idempotent:false});
  async function artifact(tx:SQL,a:Actor,artifactId:string,write=false){const f=(await tx.query('SELECT * FROM artifacts WHERE id=$1',[artifactId])).rows[0];if(!f)throw new Problem(404,'NOT_FOUND','Версия исходников не найдена');await member(tx,a,f.project_id,write);return f;}
  route('GET','/artifacts/:id/download','Скачать неизменяемый ZIP версии',null,async(tx,a,req,reply)=>{
    const f=await artifact(tx,a,req.params.id);return reply.type('application/zip').header('Content-Disposition',`attachment; filename="project-${f.id}.zip"; filename*=UTF-8''${encodeURIComponent(f.filename)}`).send(createReadStream(blob(f.sha256)));
  });
  route('GET','/artifacts/:id/file','Просмотреть текстовый файл исходного проекта',null,async(tx,a,req)=>{
    const f=await artifact(tx,a,req.params.id);const path=new URL(req.url,'http://local').searchParams.get('path');if(!path||!f.files.some((x:any)=>x.path===path))throw new Problem(404,'NOT_FOUND','Файл не найден');
    const scan=await inspectArchive(blob(f.sha256),path);return {path,content:scan.content??''};
  });
  route('GET','/artifacts/:id/raw','Полное содержимое файла без обрезки',null,async(tx,a,req,reply)=>{
    const f=await artifact(tx,a,req.params.id);const path=new URL(req.url,'http://local').searchParams.get('path');
    if(!path||!f.files.some((x:any)=>x.path===path))throw new Problem(404,'NOT_FOUND','Файл не найден');
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition',"inline; filename*=UTF-8''"+encodeURIComponent(path.split('/').at(-1)!)).send(await archiveFileStream(blob(f.sha256),path));
  });
  route('PATCH','/artifacts/:id/recipe','Настроить установку этой версии проекта',object({type:choice('compose','dockerfile','node','none'),path:text(200,0),port:integer(1,65535)},['type','port']),async(tx,a,req)=>{
    const f=await artifact(tx,a,req.params.id,true);await sourceWriter(tx,a,f.project_id,Number(req.headers['x-work-generation']));
    const names=f.files.map((x:any)=>x.path.slice(f.recipe.root.length));
    if(req.body.type==='compose'&&(!req.body.path||!names.includes(req.body.path)||!/^[-\w./]+$/.test(req.body.path)))throw new Problem(422,'INVALID_RECIPE','Выберите существующий Compose-файл с латинским именем');
    if(req.body.type==='dockerfile'&&!names.includes('Dockerfile'))throw new Problem(422,'INVALID_RECIPE','В корне проекта отсутствует Dockerfile');
    if(req.body.type==='node'&&!names.includes('package.json'))throw new Problem(422,'INVALID_RECIPE','В корне проекта отсутствует package.json');
    const running=(await tx.query("SELECT id FROM installations WHERE artifact_id=$1 AND state IN ('pending','running') AND expires_at>$2",[f.id,Date.now()])).rows.length;
    if(running)throw new Problem(409,'INSTALL_PENDING','Сначала завершите или дождитесь истечения выданной команды установки');
    await tx.query('UPDATE artifacts SET recipe=$1 WHERE id=$2',[JSON.stringify({...f.recipe,...req.body}),f.id]);await event(tx,a,f.project_id,'source.recipe','Настроен запуск версии проекта',{artifact_id:f.id});return {ok:true};
  });
  route('POST','/artifacts/:id/installations','Выдать ограниченную команду установки версии на свой сервер',object({}),async(tx,a,req)=>{
    const f=await artifact(tx,a,req.params.id,true);await sourceWriter(tx,a,f.project_id,Number(req.headers['x-work-generation']));if(f.recipe.type==='none')throw new Problem(422,'RECIPE_REQUIRED','Настройте запуск: Docker Compose, Dockerfile или Node.js');
    const raw=token(),job=id(),now=Date.now();await tx.query('INSERT INTO installations (id,project_id,artifact_id,token_hash,expires_at,created_by,created_at,updated_at,recipe,agent_id,work_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)',[job,f.project_id,f.id,digest(raw),now+3600000,a.userId,now,JSON.stringify(f.recipe),a.agentId??null,a.agentId?Number(req.headers['x-work-generation']):null]);
    await event(tx,a,f.project_id,'install.issued','Выдана команда установки версии',{installation_id:job,artifact_id:f.id});
    const origin=options.origin??'http://127.0.0.1:19090';
    return {id:job,expires_at:now+3600000,command:`curl -fsS '${origin}/installer.sh' -o /tmp/d2d-install.sh && D2D_URL='${origin}' D2D_INSTALL_ID='${job}' D2D_INSTALL_TOKEN='${raw}' bash /tmp/d2d-install.sh`};
  },{idempotent:false});
  app.get('/installer.sh',{schema:{hide:true}},async(_req,reply)=>reply.type('text/x-shellscript; charset=utf-8').header('Cache-Control','no-store').send(await readFile(resolve('scripts/project-installer.sh'),'utf8')));
  async function installation(req:any,tx:SQL){const raw=String(req.headers.authorization??'');if(!raw.startsWith('Bearer '))throw new Problem(401,'UNAUTHENTICATED','Нужен токен установки');
    const job=(await tx.query(`SELECT i.*,a.sha256,a.filename FROM installations i JOIN artifacts a ON a.id=i.artifact_id JOIN projects p ON p.id=i.project_id
      JOIN members m ON m.project_id=i.project_id AND m.user_id=i.created_by WHERE i.id=$1 AND i.token_hash=$2 AND i.expires_at>$3 AND p.archived_at IS NULL
      AND ((i.agent_id IS NULL AND m.role='admin') OR (i.agent_id IS NOT NULL AND m.role IN ('admin','developer') AND EXISTS (
        SELECT 1 FROM agents g JOIN work_sessions w ON w.executor_id=g.id AND w.project_id=g.project_id
        WHERE g.id=i.agent_id AND g.owner_id=i.created_by AND g.project_id=i.project_id AND g.revoked_at IS NULL AND g.expires_at>$3
        AND g.scopes @> '["write"]'::jsonb AND w.generation=i.work_generation AND w.state IN ('active','paused','review') AND w.expires_at>$3)))`,[req.params.id,digest(raw.slice(7)),Date.now()])).rows[0];
    if(!job)throw new Problem(401,'INSTALL_TOKEN_EXPIRED','Команда установки истекла или доступ отозван');return job;
  }
  app.get<{Params:{id:string}}>('/api/install/:id/archive',{schema:{hide:true}},async(req,reply)=>{const job=await db.transaction(tx=>installation(req,tx));return reply.type('application/zip').header('Cache-Control','no-store').send(createReadStream(blob(job.sha256)));});
  app.post<{Params:{id:string};Body:{host:string}}>('/api/install/:id/claim',{schema:{body:object({host:{...text(100),pattern:'^[a-zA-Z0-9._-]+$'}}),hide:true}},async(req)=>db.transaction(async tx=>{
    await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');const job=await installation(req,tx);if(job.host&&job.host!==req.body.host)throw new Problem(409,'INSTALL_ALREADY_CLAIMED','Команда уже используется другим сервером');
    if(job.state==='failed')throw new Problem(409,'INSTALL_FAILED','Предыдущая попытка завершилась ошибкой. Выдайте новую команду');
    await tx.query("UPDATE installations SET host=$1,state=CASE WHEN state='installed' THEN state ELSE 'running' END,updated_at=$2 WHERE id=$3",[req.body.host,Date.now(),job.id]);
    return {project_id:job.project_id,artifact_id:job.artifact_id,sha256:job.sha256,recipe:job.recipe,state:job.state};
  }));
  app.post<{Params:{id:string};Body:{host:string;state:string;message:string}}>('/api/install/:id/result',{schema:{body:object({host:{...text(100),pattern:'^[a-zA-Z0-9._-]+$'},state:choice('installed','failed'),message:text(1000,0)}),hide:true}},async(req)=>db.transaction(async tx=>{
    await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');const job=await installation(req,tx);if(job.host!==req.body.host)throw new Problem(409,'INSTALL_HOST_MISMATCH','Сервер не совпадает');
    if(['failed','installed'].includes(job.state)&&job.state!==req.body.state)throw new Problem(409,'INSTALL_TERMINAL','Результат установки уже сохранён');
    await tx.query('UPDATE installations SET state=$1,message=$2,updated_at=$3 WHERE id=$4',[req.body.state,req.body.message,Date.now(),job.id]);
    await tx.query('INSERT INTO events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id(),job.project_id,job.created_by,req.body.host,'install.result',req.body.state==='installed'?'Проект установлен на сервер':'Ошибка установки',JSON.stringify({installation_id:job.id,artifact_id:job.artifact_id,message:req.body.message}),Date.now()]);return {ok:true};
  }));
}

export async function storeSource(tx:SQL,a:Actor,projectId:string,blobs:string,upload:{temp:string;sha:string;bytes:number;scan?:Awaited<ReturnType<typeof inspectArchive>>},inputName:string){
    const scan=upload.scan??await inspectArchive(upload.temp);const sha=upload.sha;
    const old=(await tx.query('SELECT * FROM artifacts WHERE project_id=$1 AND sha256=$2',[projectId,sha])).rows[0];if(old)return {artifact:old};
    const names=scan.files.map(f=>f.path.slice(scan.root.length));
    const compose=['compose.yaml','compose.yml','docker-compose.yml','docker-compose.yaml'].find(n=>names.includes(n));
    const recipe={type:compose?'compose':names.includes('Dockerfile')?'dockerfile':names.includes('package.json')?'node':'none',path:compose??'',root:scan.root,port:3000};
    await rename(upload.temp,resolve(blobs,sha+'.zip'));
    const artifactId=id();let filename='project.zip';try{filename=decodeURIComponent(inputName).replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,100);}catch{}
    const artifact=(await tx.query('INSERT INTO artifacts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[artifactId,projectId,sha,filename,upload.bytes,JSON.stringify(scan.files),JSON.stringify(recipe),a.userId,Date.now()])).rows[0];
    await event(tx,a,projectId,'source.uploaded',`Загружен исходный проект: ${filename}`,{artifact_id:artifactId,sha256:sha,files:scan.files.length});return {artifact};
}
