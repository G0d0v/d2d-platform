import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Database,SQL} from './db.ts';
import {human} from './auth.ts';
import {event,member,ownedWork,sourceWriter,type Actor} from './model.ts';
import {choice,generation,integer,object,text} from './contracts.ts';
import {digest,id,Problem} from './security.ts';
import {storeSource,type Register} from './source-routes.ts';
import type {Forgejo} from './forgejo.ts';
import {registerGitGateway} from './git-gateway.ts';
import {importSource} from './git-source.ts';
import {GitHistory,recordOwnership} from './git-history.ts';

export function registerGitRoutes(app:FastifyInstance,route:Register,db:Database,options:{git?:Forgejo;origin:string;dataDir?:string}){
  const {git}=options,blobs=resolve(options.dataDir??'.d2d','blobs');
  const history=git?new GitHistory(git,resolve(options.dataDir??'.d2d','git-cache')):undefined;
  registerGitGateway(app,db,git,history);
  const client=()=>{if(!git)throw new Problem(503,'GIT_NOT_CONFIGURED','Git ещё не настроен');return git;};
  const base=(project:string)=>`/repos/${client().repo(project)}`;
  const param=(req:any,name:string,fallback='')=>new URL(req.url,'http://local').searchParams.get(name)??fallback;
  const write=async(tx:SQL,a:Actor,req:any)=>ownedWork(tx,a,req.params.id,Number(req.headers['x-work-generation']));
  route('GET','/projects/:id/git','Репозиторий, ветки и адрес clone/push',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);if(!git)return {configured:false,repository:null,branches:[]};
    const repo=await git.exists(req.params.id);
    return {configured:true,repository:repo?{name:repo.name,default_branch:repo.default_branch,empty:repo.empty,clone_url:`${options.origin}/git/${req.params.id}.git`}:null,branches:repo&&!repo.empty?await git.json(base(req.params.id)+'/branches?limit=100'):[]};
  });
  route('POST','/projects/:id/git','Включить приватный Git-репозиторий',object({}),async(tx,a,req)=>{
    await sourceWriter(tx,a,req.params.id,Number(req.headers['x-work-generation']));
    const repo=await client().ensure(req.params.id);await event(tx,a,req.params.id,'git.created','Подключён Git-репозиторий');return {repository:{name:repo.name,clone_url:`${options.origin}/git/${req.params.id}.git`}};
  });
  route('GET','/projects/:id/git/tree','Файлы и каталоги выбранной Git-версии',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);const ref=param(req,'ref','main'),path=param(req,'path');
    const result=await client().json(`${base(req.params.id)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    return {entries:Array.isArray(result)?result:[result]};
  });
  route('GET','/projects/:id/git/raw','Полный файл из Git',null,async(tx,a,req,reply)=>{
    await member(tx,a,req.params.id);const path=param(req,'path');if(!path)throw new Problem(422,'PATH_REQUIRED','Укажите путь файла');
    const r=await client().request(`${base(req.params.id)}/raw/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(param(req,'ref','main'))}`);
    return reply.type('text/plain; charset=utf-8').send(Readable.fromWeb(r.body as any));
  });
  route('GET','/projects/:id/git/commits','История коммитов выбранной ветки',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);const commits=await client().json(`${base(req.params.id)}/commits?sha=${encodeURIComponent(param(req,'ref','main'))}&limit=30&page=${Math.max(1,Number(param(req,'page','1'))||1)}`);
    const own=new Set((await tx.query('SELECT commit_sha FROM git_ownership WHERE project_id=$1 AND user_id=$2',[req.params.id,a.userId])).rows.map(r=>r.commit_sha));
    return {commits:commits.map((c:any)=>({...c,owned_by_me:own.has(c.sha)}))};
  });
  route('GET','/projects/:id/git/file-metadata','Даты добавления/обновления файлов и последний коммит, по 100 файлов',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);client();return history!.metadata(req.params.id,param(req,'ref','main'),param(req,'path'),Math.max(1,Number(param(req,'page','1'))||1));
  });
  route('GET','/projects/:id/git/file-history','Полная постраничная история файла, включая переименования',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);client();const path=param(req,'path');if(!path)throw new Problem(422,'PATH_REQUIRED','Выберите файл');
    const result=await history!.fileHistory(req.params.id,param(req,'ref','main'),path,Math.max(1,Number(param(req,'page','1'))||1));
    const own=new Set((await tx.query('SELECT commit_sha FROM git_ownership WHERE project_id=$1 AND user_id=$2',[req.params.id,a.userId])).rows.map(r=>r.commit_sha));
    return {...result,commits:result.commits.map(c=>({...c,owned_by_me:own.has(c.sha)}))};
  });
  route('GET','/projects/:id/git/commit-diff','Красно-зелёные изменения конкретного коммита',null,async(tx,a,req,reply)=>{
    await member(tx,a,req.params.id);client();const sha=param(req,'sha');if(!/^[a-f0-9]{40,64}$/.test(sha))throw new Problem(422,'COMMIT_REQUIRED','Выберите конкретный коммит');
    return reply.type('text/plain; charset=utf-8').send(await history!.diff(req.params.id,sha));
  });
  route('GET','/projects/:id/git/compare','Сравнить две версии: добавленные, изменённые, удалённые файлы и полный diff',null,async(tx,a,req,reply)=>{
    await member(tx,a,req.params.id);client();const from=param(req,'from'),to=param(req,'to');
    if(!from||!to||from.length>200||to.length>200)throw new Problem(422,'VERSIONS_REQUIRED','Выберите исходную и новую версии');
    const result=await history!.compare(req.params.id,from,to,param(req,'format')!=='summary');return param(req,'format')==='diff'?reply.type('text/plain; charset=utf-8').send(result.diff):result;
  });
  route('GET','/projects/:id/git/delta','Скачать проверяемый пакет только изменённых файлов между версиями',null,async(tx,a,req,reply)=>{
    await member(tx,a,req.params.id);client();const from=param(req,'from'),to=param(req,'to');
    if(!from||!to||from.length>200||to.length>200)throw new Problem(422,'VERSIONS_REQUIRED','Выберите две версии');
    const pack=await history!.delta(req.params.id,from,to);
    return reply.type('application/zip').header('X-Checksum-Sha256',pack.sha256).header('Content-Disposition',`attachment; filename="update-${pack.base_sha.slice(0,12)}-${pack.head_sha.slice(0,12)}.zip"`).send(createReadStream(pack.path));
  });
  route('POST','/projects/:id/git/revert','Откатить свой коммит новым коммитом в рабочей ветке',object({sha:{...text(64),pattern:'^[a-f0-9]{40,64}$'},ref:text(200),expected_head:{...text(64),pattern:'^[a-f0-9]{40,64}$'},generation}),async(tx,a,req)=>{
    const w=await write(tx,a,req),owned=(await tx.query('SELECT user_id FROM git_ownership WHERE project_id=$1 AND commit_sha=$2',[req.params.id,req.body.sha])).rows[0];
    if(!owned||owned.user_id!==a.userId)throw new Problem(403,'NOT_YOUR_COMMIT','Можно откатить только изменения, отправленные вами или вашим агентом');
    client();const result=await history!.revert(req.params.id,req.body.ref,req.body.expected_head,req.body.sha,w.branch,a);
    await recordOwnership(tx,req.params.id,result.commit_sha,a,w);await event(tx,a,req.params.id,'git.reverted','Свои изменения отменены новым Git-коммитом',{original_sha:req.body.sha,...result,generation:w.generation});return result;
  },{authorize:async(tx,a,req)=>{await write(tx,a,req);}});
  route('POST','/projects/:id/git/branches','Создать ветку',object({name:text(200),from:text(200)}),async(tx,a,req)=>{
    await write(tx,a,req);const branch=await client().json(base(req.params.id)+'/branches','POST',{new_branch_name:req.body.name,old_ref_name:req.body.from});await event(tx,a,req.params.id,'git.branch','Создана ветка',{name:req.body.name,from:req.body.from});return {branch};
  });
  route('POST','/projects/:id/git/import','Записать архив в Git с сохранением истории',object({artifact_id:text(80),message:text(500)}),async(tx,a,req)=>{
    const w=await write(tx,a,req);const f=(await tx.query('SELECT * FROM artifacts WHERE id=$1 AND project_id=$2',[req.body.artifact_id,req.params.id])).rows[0];
    if(!f)throw new Problem(404,'NOT_FOUND','Версия не найдена');await client().ensure(req.params.id);
    const repo=await client().exists(req.params.id);const branch=repo.empty?'main':w.branch;
    const commit=await importSource(client(),req.params.id,f,resolve(blobs,f.sha256+'.zip'),resolve(options.dataDir??'.d2d','git-work'),branch,a,req.body.message);
    await recordOwnership(tx,req.params.id,commit,a,w);
    await event(tx,a,req.params.id,'git.import','Исходники записаны в Git',{artifact_id:f.id,commit_sha:commit,branch});return {commit_sha:commit,branch};
  });
  route('POST','/projects/:id/git/snapshot','Подготовить установочную версию из точного Git-коммита',object({ref:text(200)}),async(tx,a,req)=>{
    await sourceWriter(tx,a,req.params.id,Number(req.headers['x-work-generation']));
    const commit=await client().json(`${base(req.params.id)}/git/commits/${encodeURIComponent(req.body.ref)}`),sha=commit.sha;
    if(!/^[a-f0-9]{40,64}$/.test(sha))throw new Problem(503,'GIT_UNAVAILABLE','Git вернул некорректный коммит');
    const old=(await tx.query('SELECT * FROM artifacts WHERE project_id=$1 AND commit_sha=$2',[req.params.id,sha])).rows[0];if(old)return {artifact:old};
    await mkdir(blobs,{recursive:true,mode:0o700});const temp=resolve(blobs,id()+'.git-upload'),hash=createHash('sha256');let bytes=0;
    try{
      const r=await client().request(`${base(req.params.id)}/archive/${sha}.zip`);
      await pipeline(Readable.fromWeb(r.body as any),new Transform({transform(chunk,_enc,done){bytes+=chunk.length;hash.update(chunk);done(null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
      const stored=await storeSource(tx,a,req.params.id,blobs,{temp,sha:hash.digest('hex'),bytes},`git-${sha.slice(0,12)}.zip`);
      await tx.query('UPDATE artifacts SET commit_sha=$1 WHERE id=$2',[sha,stored.artifact.id]);stored.artifact.commit_sha=sha;return stored;
    }finally{await rm(temp,{force:true});}
  });
  route('GET','/projects/:id/git/pulls','Запросы проверки изменений',null,async(tx,a,req)=>{
    await member(tx,a,req.params.id);const pulls=await client().json(base(req.params.id)+'/pulls?state=all&sort=recentupdate&limit=50');
    const reviews=(await tx.query('SELECT r.*,u.display_name AS reviewer_name FROM git_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.project_id=$1 ORDER BY r.created_at DESC',[req.params.id])).rows;
    return {pulls,reviews};
  });
  route('POST','/projects/:id/git/pulls','Создать запрос проверки',object({title:text(200),body:text(10000,0),head:text(200),base:text(200)}),async(tx,a,req)=>{
    await write(tx,a,req);const marker=`<!-- d2d:${digest(a.id+String(req.headers['idempotency-key']))} -->`;
    const existing=await client().json(base(req.params.id)+'/pulls?state=open&limit=100');
    let pull=existing.find((p:any)=>String(p.body).includes(marker));
    if(!pull)pull=await client().json(base(req.params.id)+'/pulls','POST',{title:req.body.title,body:`${req.body.body}\n\nАвтор D2D: ${a.name}\n${marker}`,head:req.body.head,base:req.body.base});
    await tx.query('INSERT INTO git_changes VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[req.params.id,pull.number,a.id,a.userId,Date.now()]);
    await event(tx,a,req.params.id,'git.pull.created','Запрошена проверка изменений',{number:pull.number});return {pull};
  });
  route('GET','/projects/:id/git/diff','Полный diff запроса изменений',null,async(tx,a,req,reply)=>{
    await member(tx,a,req.params.id);const number=Number(param(req,'number'));if(!Number.isSafeInteger(number)||number<1)throw new Problem(422,'VALIDATION_ERROR','Укажите номер проверки');
    const r=await client().request(`${base(req.params.id)}/pulls/${number}.diff`);return reply.type('text/plain; charset=utf-8').send(Readable.fromWeb(r.body as any));
  });
  route('POST','/projects/:id/git/reviews','Сохранить проверку конкретного коммита',object({number:integer(1,2147483647),state:choice('approved','changes_requested'),body:text(10000,0),head_sha:text(64)}),async(tx,a,req)=>{
    human(a);await member(tx,a,req.params.id,true);const pull=await client().json(`${base(req.params.id)}/pulls/${req.body.number}`);
    const author=(await tx.query('SELECT * FROM git_changes WHERE project_id=$1 AND number=$2',[req.params.id,req.body.number])).rows[0];
    if(!author||author.author_user_id===a.userId)throw new Problem(403,'SELF_REVIEW','Проверку подтверждает другой участник проекта');
    if(pull.state!=='open'||pull.head.sha!==req.body.head_sha)throw new Problem(409,'GIT_CHANGED','Изменения обновились. Прочитайте новый diff');
    const previous=(await tx.query('SELECT max(created_at) AS time FROM git_reviews WHERE project_id=$1 AND number=$2 AND reviewer_id=$3',[req.params.id,req.body.number,a.userId])).rows[0];
    await tx.query('INSERT INTO git_reviews VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id(),req.params.id,req.body.number,a.userId,pull.head.sha,req.body.state,req.body.body,Math.max(Date.now(),Number(previous.time??0)+1)]);
    await event(tx,a,req.params.id,'git.review','Сохранена проверка изменений',{number:pull.number,state:req.body.state,head_sha:pull.head.sha});return {ok:true};
  });
  route('POST','/projects/:id/git/merge','Объединить проверенные изменения без устаревшего одобрения',object({number:integer(1,2147483647),head_sha:text(64)}),async(tx,a,req)=>{
    human(a);await write(tx,a,req);const pull=await client().json(`${base(req.params.id)}/pulls/${req.body.number}`);
    if(pull.merged)return {ok:true};if(pull.head.sha!==req.body.head_sha)throw new Problem(409,'GIT_CHANGED','Коммит изменился. Обновите проверку');
    const latest=(await tx.query(`SELECT DISTINCT ON (r.reviewer_id) r.* FROM git_reviews r JOIN members m ON m.project_id=r.project_id AND m.user_id=r.reviewer_id WHERE r.project_id=$1 AND r.number=$2 AND r.head_sha=$3 AND m.role<>'viewer' ORDER BY r.reviewer_id,r.created_at DESC,r.id`,[req.params.id,pull.number,pull.head.sha])).rows;
    if(!latest.some(r=>r.state==='approved')||latest.some(r=>r.state==='changes_requested'))throw new Problem(409,'REVIEW_REQUIRED','Нужно актуальное одобрение другого разработчика без незакрытых замечаний');
    await client().json(`${base(req.params.id)}/pulls/${pull.number}/merge`,'POST',{Do:'merge',head_commit_id:pull.head.sha,delete_branch_after_merge:false});
    await event(tx,a,req.params.id,'git.merged','Изменения объединены',{number:pull.number,head_sha:pull.head.sha});return {ok:true};
  });
  route('GET','/projects/:id/git/releases','Опубликованные Git-версии',null,async(tx,a,req)=>{await member(tx,a,req.params.id);return {releases:await client().json(base(req.params.id)+'/releases?limit=50')};});
  route('POST','/projects/:id/git/releases','Опубликовать версию, закреплённую за коммитом',object({tag:text(100),name:text(200),body:text(10000,0),ref:text(200)}),async(tx,a,req)=>{
    await write(tx,a,req);const commit=await client().json(`${base(req.params.id)}/git/commits/${encodeURIComponent(req.body.ref)}`);
    const previous=(await client().json(base(req.params.id)+'/releases?limit=100')).find((r:any)=>!r.draft&&!r.prerelease);
    let description=req.body.body;
    if(previous){const changes=await history!.compare(req.params.id,/^[a-f0-9]{40,64}$/.test(previous.target_commitish??'')?previous.target_commitish:previous.tag_name,commit.sha,false);const labels:Record<string,string>={A:'Добавлен',M:'Изменён',D:'Удалён',T:'Изменён тип'};
      description+=`\n\n## Изменения относительно ${previous.tag_name}\n\n`+(changes.files.length?changes.files.slice(0,100).map(f=>`- ${labels[f.status]??f.status}: \`${f.path.replace(/[\r\n`<>]/g,'')}\``).join('\n'):'Файлы исходного кода не изменились.')+`\n\nСравнение: ${changes.base_sha.slice(0,12)} → ${changes.head_sha.slice(0,12)}. Файлов: ${changes.files.length}. Полный diff и пакет обновления доступны в карточке релиза D2D.`;
    }
    const release=await client().json(base(req.params.id)+'/releases','POST',{tag_name:req.body.tag,target_commitish:commit.sha,name:req.body.name,body:description,draft:false,prerelease:false});
    await event(tx,a,req.params.id,'git.release','Опубликована Git-версия',{tag:req.body.tag,commit_sha:commit.sha});return {release};
  });
}
