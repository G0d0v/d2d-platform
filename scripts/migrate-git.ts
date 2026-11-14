import {database} from '../server/db.ts';
import {Forgejo} from '../server/forgejo.ts';
import {admin,event,type Actor} from '../server/model.ts';
import {importSource} from '../server/git-source.ts';
import {resolve} from 'node:path';

if(!process.env.DATABASE_URL||!process.env.FORGEJO_URL||!process.env.FORGEJO_TOKEN)throw new Error('Нужна серверная конфигурация D2D и Forgejo');
const db=await database(process.env.DATABASE_URL),git=new Forgejo({url:process.env.FORGEJO_URL,token:process.env.FORGEJO_TOKEN,owner:process.env.FORGEJO_OWNER??'d2d-service'}),data=process.env.DATA_DIR??'.d2d';
let created=0,imported=0;
try{
 const projects=(await db.query('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at')).rows;
 for(const project of projects)await db.transaction(async tx=>{
  await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');
  const m=(await tx.query("SELECT user_id FROM members WHERE project_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",[project.id])).rows[0];if(!m)return;
  const actor:Actor={id:'system:git-migration',userId:m.user_id,name:'D2D · подключение Git',role:'member',scopes:['read','write']};await admin(tx,actor,project.id);
  const old=await git.exists(project.id),repo=old??await git.ensure(project.id);if(!old)created++;
  if(!repo.empty)return;
  const artifact=(await tx.query('SELECT * FROM artifacts WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[project.id])).rows[0];
  if(!artifact){if(!old)await event(tx,actor,project.id,'git.created','Подключён приватный Git-репозиторий');return;}
  const sha=await importSource(git,project.id,artifact,resolve(data,'blobs',artifact.sha256+'.zip'),resolve(data,'git-work'),'main',actor,'Начальная версия из загруженного проекта');
  await tx.query('UPDATE artifacts SET commit_sha=$1 WHERE id=$2',[sha,artifact.id]);await event(tx,actor,project.id,'git.import','Загруженные исходники перенесены в Git',{artifact_id:artifact.id,commit_sha:sha,branch:'main'});imported++;
 });
 console.log(JSON.stringify({repositories_created:created,archives_imported:imported}));
}finally{await db.close();}
