import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,rename,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {receiveFiles,safeSourcePath,FILES_MEDIA} from './file-upload.ts';
import {commitFiles} from './git-source.ts';
import {GitHistory} from './git-history.ts';
import {database} from './db.ts';
import {createApp} from './app.ts';
import type {Forgejo} from './forgejo.ts';
import type {Actor} from './model.ts';

const python=process.platform==='win32'?'python':'python3';
function run(cwd:string,args:string[]){const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function frame(files:{path:string;content:Buffer}[]){const manifest=Buffer.from(JSON.stringify({files:files.map(f=>({path:f.path,size:f.content.length}))})),size=Buffer.alloc(4);size.writeUInt32BE(manifest.length);return Buffer.concat([size,manifest,...files.map(f=>f.content)]);}
const actor={id:'actor',userId:'user',name:'Uploader',role:'admin',scopes:['write']} as Actor;

test('файлы передаются потоком: Unicode, пустой файл, границы пакетов, лишние/недостающие байты и опасные пути',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d2d-file-stream-'));
 try{
  const packed=frame([{path:'src/пример.ts',content:Buffer.from('привет')},{path:'empty.txt',content:Buffer.alloc(0)}]);
  const files=await receiveFiles(Readable.from(Array.from(packed,b=>Buffer.from([b]))),join(root,'ok'));
  assert.equal(files.length,2);assert.equal(await readFile(join(root,'ok','0'),'utf8'),'привет');assert.equal((await stat(join(root,'ok','1'))).size,0);
  await assert.rejects(receiveFiles(Readable.from([packed.subarray(0,-1)]),join(root,'short')),/прервана/);
  await assert.rejects(receiveFiles(Readable.from([Buffer.concat([packed,Buffer.from('x')])]),join(root,'extra')),/лишние/);
  for(const path of ['../outside','/abs','a\\b','.GIT/config','src/.env','secret.PEM','src/./x','x//y','x:ads','x.'])assert.throws(()=>safeSourcePath(path));
  assert.equal(safeSourcePath('src/.env.example'),'src/.env.example');
  await assert.rejects(receiveFiles(Readable.from([frame([{path:'x',content:Buffer.alloc(0)},{path:'X',content:Buffer.alloc(0)}])]),join(root,'duplicate')),/повторяются/);
  await assert.rejects(receiveFiles(Readable.from([frame([{path:'x',content:Buffer.alloc(0)},{path:'x/y',content:Buffer.alloc(0)}])]),join(root,'conflict')),/папкой/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('настоящий Git: загрузка в папку/новую ветку сохраняет соседние файлы; устаревшая база не проходит; delta содержит бинарные изменения/удаления',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d2d-file-git-')),project='00000000-0000-4000-8000-000000000001';
 try{
  const bare=join(root,'remote.git'),checkout=join(root,'initial');await mkdir(checkout);
  run(root,['init','--bare','--initial-branch=main',bare]);run(checkout,['init','--initial-branch=main']);
  await mkdir(join(checkout,'src'));await writeFile(join(checkout,'src','keep.txt'),'keep');await writeFile(join(checkout,'src','change.txt'),'before');await writeFile(join(checkout,'old.txt'),'delete me');
  run(checkout,['add','.']);run(checkout,['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','release 1']);run(checkout,['remote','add','origin',bare]);run(checkout,['push','origin','main']);const base=run(checkout,['rev-parse','HEAD']);
  const git={options:{url:root,owner:'service',token:'unused'},repo:()=> 'remote'} as unknown as Forgejo;
  const upload=join(root,'upload');await mkdir(upload);await writeFile(join(upload,'0'),Buffer.from([0,1,2,255]));
  const target={branch:'feature/files',from:base,expected_head:base,new_branch:true,path:'src',message:'Бинарный файл в отдельной ветке'};
  const committed=await commitFiles(git,project,{directory:upload,files:[{path:'change.txt',size:4}]},join(root,'work'),target,actor);
  assert.notEqual(committed.commit_sha,base);assert.equal(run(bare,['show','feature/files:src/keep.txt']),'keep');assert.equal(run(bare,['rev-parse','main']),base);
  const emptyRemote=join(root,'empty.git');run(root,['init','--bare','--initial-branch=main',emptyRemote]);
  const emptyGit={options:git.options,repo:()=> 'empty',exists:async()=>({empty:false,default_branch:'main'}),json:async(_path:string,_method:string,body:any)=>{run(emptyRemote,['symbolic-ref','HEAD','refs/heads/'+body.default_branch]);}} as unknown as Forgejo;
  const first=await commitFiles(emptyGit,project,{directory:upload,files:[{path:'binary.dat',size:4}]},join(root,'work'),{...target,branch:'develop',from:'',expected_head:'',path:''},actor);
  assert.equal(run(emptyRemote,['symbolic-ref','HEAD']),'refs/heads/develop');assert.equal(run(emptyRemote,['rev-parse','develop']),first.commit_sha);
  await assert.rejects(commitFiles(git,project,{directory:upload,files:[{path:'change.txt',size:4}]},join(root,'work'),{...target,new_branch:false,expected_head:base},actor),/изменилась/);
  run(checkout,['fetch','origin']);run(checkout,['checkout','feature/files']);await rm(join(checkout,'old.txt'));await rename(join(checkout,'src','keep.txt'),join(checkout,'renamed.txt'));run(checkout,['add','-A']);run(checkout,['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','release 2']);run(checkout,['push','origin','feature/files']);const head=run(checkout,['rev-parse','HEAD']);
  const history=new GitHistory(git,join(root,'cache')),comparison=await history.compare(project,base,head);
  assert.equal(comparison.files.find(f=>f.path==='old.txt')?.status,'D');assert.match(comparison.diff,/Binary files/);
  const pack=await history.delta(project,base,head);assert.match(pack.sha256,/^[a-f0-9]{64}$/);
  const installed=join(root,'installed');run(root,['clone','--branch','main',bare,installed]);await rm(join(installed,'.git'),{recursive:true,force:true});
  let applied=spawnSync(python,[resolve('scripts/apply-project-update.py'),pack.path,installed,'--check'],{encoding:'utf8',windowsHide:true});assert.equal(applied.status,0,applied.stderr);
  await writeFile(join(installed,'src','keep.txt'),'local change');applied=spawnSync(python,[resolve('scripts/apply-project-update.py'),pack.path,installed],{encoding:'utf8',windowsHide:true});assert.notEqual(applied.status,0);assert.equal(await readFile(join(installed,'src','change.txt'),'utf8'),'before');
  await writeFile(join(installed,'src','keep.txt'),'keep');applied=spawnSync(python,[resolve('scripts/apply-project-update.py'),pack.path,installed],{encoding:'utf8',windowsHide:true});assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(await readFile(join(installed,'src','change.txt')),Buffer.from([0,1,2,255]));assert.equal(await readFile(join(installed,'renamed.txt'),'utf8'),'keep');await assert.rejects(stat(join(installed,'old.txt')));await assert.rejects(stat(join(installed,'src','keep.txt')));
 }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
});

test('новый API загрузки: анонимный/наблюдатель/read-агент не передают данные, передача работы блокирует старое поколение',async()=>{
 const root=await mkdtemp(join(tmpdir(),'d2d-files-api-')),db=await database(),app=await createApp({db,registration:'open',dataDir:root});
 async function call(headers:any,method:any,path:string,payload?:any,extra={}){return app.inject({method,url:'/api/v1'+path,headers:{...headers,'idempotency-key':crypto.randomUUID(),...extra},payload});}
 try{
  const a=await call({},'POST','/auth/register',{login:'fileowner',display_name:'Owner',password:'files-test-password'}),headers={cookie:`d2d_session=${a.cookies[0].value}`,'x-csrf-token':a.json().csrf};
  const p=(await call(headers,'POST','/projects',{name:'Files',slug:'files-test'})).json().project;
  const payload=frame([{path:'x',content:Buffer.from('x')}]),extra={'content-type':FILES_MEDIA};
  assert.equal((await call({},'POST',`/projects/${p.id}/git/upload`,payload,extra)).statusCode,401);
  const w=(await call(headers,'POST',`/projects/${p.id}/work-sessions`,{note:'Upload files'})).json().work;
  const stale={...extra,'x-work-generation':String(w.generation+1)};assert.equal((await call(headers,'POST',`/projects/${p.id}/git/upload`,payload,stale)).statusCode,409);
  const viewer=await call({},'POST','/auth/register',{login:'fileviewer',display_name:'Viewer',password:'files-test-password'}),vh={cookie:`d2d_session=${viewer.cookies[0].value}`,'x-csrf-token':viewer.json().csrf};
  await call(headers,'POST',`/projects/${p.id}/members`,{login:'fileviewer',role:'viewer'});assert.equal((await call(vh,'POST',`/projects/${p.id}/git/upload`,payload,extra)).statusCode,403);
  const read=(await call(headers,'POST',`/projects/${p.id}/agents`,{name:'Read agent',scopes:['read'],hours:1})).json();assert.equal((await call({authorization:'Bearer '+read.token},'POST',`/projects/${p.id}/git/upload`,payload,extra)).statusCode,403);
  assert.equal((await call(vh,'GET',`/projects/${p.id}/git/compare?from=main&to=main`)).statusCode,503);
  assert.equal((await call(headers,'POST',`/projects/${p.id}/members/update`,{user_id:viewer.json().user.id,role:'developer'})).statusCode,200);
  const transfer=await call(headers,'POST',`/work-sessions/${w.id}/handoff`,{generation:w.generation,to_user_id:viewer.json().user.id,summary:'Передаю загрузку'});assert.equal(transfer.statusCode,200,transfer.body);
  assert.equal((await call(headers,'POST',`/projects/${p.id}/git/upload`,payload,{...extra,'x-work-generation':String(w.generation)})).statusCode,409);
 }finally{await app.close();await db.close();await rm(root,{recursive:true,force:true});}
});
