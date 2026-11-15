import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,rm,rename} from 'node:fs/promises';
import {existsSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import type {Forgejo} from './forgejo.ts';
import type {SQL} from './db.ts';
import type {Actor} from './model.ts';
import {Problem} from './security.ts';

const repositoryLocks=new Map<string,Promise<unknown>>();
export class GitHistory {
 private locks=repositoryLocks;
 private metadataCache=new Map<string,any>();
 constructor(private git:Forgejo,private root:string){}
 private async run(cwd:string,args:string[],extra:Record<string,string>={}){
  return new Promise<string>((ok,fail)=>{
   const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from(this.git.options.owner+':'+this.git.options.token).toString('base64'),GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:resolve(this.root,'disabled-hooks'),GIT_CONFIG_KEY_2:'core.fsmonitor',GIT_CONFIG_VALUE_2:'false',GIT_CONFIG_KEY_3:'core.quotepath',GIT_CONFIG_VALUE_3:'false',...extra};
   const child=spawn('git',args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});const chunks:Buffer[]=[];let bytes=0,overflow=false;
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>64*1024*1024){overflow=true;child.kill();}else chunks.push(chunk);});child.stderr.resume();
   const timeout=setTimeout(()=>child.kill(),120000);child.once('error',()=>{clearTimeout(timeout);fail(new Problem(503,'GIT_UNAVAILABLE','Git недоступен'));});
   child.once('close',code=>{clearTimeout(timeout);if(code===0)ok(Buffer.concat(chunks).toString('utf8'));else fail(new Problem(409,overflow?'GIT_RESULT_TOO_LARGE':'GIT_OPERATION_FAILED',overflow?'Результат слишком велик для одного запроса':'Git не выполнил операцию. Возможен конфликт или изменение ветки. Обновите страницу.'));});
  });
 }
 private async repository<T>(project:string,fn:(run:(args:string[])=>Promise<string>)=>Promise<T>):Promise<T>{
  const key=resolve(this.root)+'\0'+project,previous=this.locks.get(key)??Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
   this.git.repo(project);await mkdir(this.root,{recursive:true,mode:0o700});const dir=resolve(this.root,project);
   if(!existsSync(resolve(dir,'HEAD')))await this.run(this.root,['clone','--mirror',`${this.git.options.url}/${this.git.repo(project)}.git`,dir]);
   else await this.run(dir,['fetch','--prune','origin','+refs/heads/*:refs/heads/*','+refs/tags/*:refs/tags/*']);
   return fn(args=>this.run(dir,args));
  });this.locks.set(key,current);try{return await current;}finally{if(this.locks.get(key)===current)this.locks.delete(key);}
 }
 private async sha(run:(args:string[])=>Promise<string>,ref:string){return (await run(['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();}
 paths(project:string,ref:string){return this.repository(project,async run=>{
  const sha=await this.sha(run,ref);
  const paths=(await run(['ls-tree','-r','-z','--name-only',sha])).split('\0').filter(Boolean);
  if(paths.length>100000)throw new Problem(422,'TREE_TOO_LARGE','Список файлов слишком велик для предварительного просмотра');
  return paths;
 });}
 snapshot(project:string){return this.repository(project,async run=>new Set((await run(['rev-list','--all'])).trim().split('\n').filter(Boolean)));}
 async recordPush(tx:SQL,project:string,a:Actor,w:any,before:Set<string>){
  const after=await this.snapshot(project);for(const sha of after)if(!before.has(sha))await recordOwnership(tx,project,sha,a,w);
 }
 metadata(project:string,ref:string,path:string,page=1){return this.repository(project,async run=>{
  const sha=await this.sha(run,ref),key=JSON.stringify([project,sha,path,page]);if(this.metadataCache.has(key))return this.metadataCache.get(key);
  const tree=await run(['ls-tree','-z',sha+(path?':'+path.replace(/\/$/,''):'' )]);
  const all=tree.split('\0').filter(Boolean),entries=all.slice((page-1)*100,page*100);const result=[];
  for(const entry of entries){const name=(path?path.replace(/\/$/,'')+'/':'')+entry.slice(entry.indexOf('\t')+1),isDir=entry.startsWith('040000'),format='%H%x00%an%x00%at%x00%s';
   const history=await run(['log',`--format=${format}`,...(!isDir?['--follow']:[]),sha,'--',name]);const lines=history.trim().split('\n').filter(Boolean);const latest=lines[0]?.split('\0'),oldest=lines.at(-1)?.split('\0');
   result.push({path:name,added_at:oldest?Number(oldest[2])*1000:null,updated_at:latest?Number(latest[2])*1000:null,last_commit_sha:latest?.[0]??null,message:latest?.slice(3).join(' ')??'',author:latest?.[1]??''});
  }const value={commit_sha:sha,files:result,has_more:all.length>page*100,page};if(this.metadataCache.size>=256)this.metadataCache.delete(this.metadataCache.keys().next().value!);this.metadataCache.set(key,value);return value;
 });}
 fileHistory(project:string,ref:string,path:string,page:number){return this.repository(project,async run=>{
  const sha=await this.sha(run,ref),raw=await run(['log','--follow','--format=%H%x00%an%x00%at%x00%s','--max-count=51',`--skip=${(page-1)*50}`,sha,'--',path]);
  const commits=raw.trim().split('\n').filter(Boolean).map(line=>{const [sha,author,time,...message]=line.split('\0');return {sha,author,date:Number(time)*1000,message:message.join(' ')};});
  return {commits:commits.slice(0,50),has_more:commits.length>50,page,ref:sha,path};
 });}
 diff(project:string,ref:string,path?:string){return this.repository(project,async run=>{const sha=await this.sha(run,ref);return run(['show','--diff-merges=first-parent','--format=','--no-ext-diff','--no-textconv','--find-renames',sha,...(path?['--',path]:[])]);});}
 compare(project:string,from:string,to:string,includeDiff=true){return this.repository(project,async run=>{
  const base=await this.sha(run,from),head=await this.sha(run,to),raw=(await run(['diff','--name-status','--no-renames','-z',base,head,'--'])).split('\0');const files=[];
  for(let i=0;i<raw.length-1;i+=2)files.push({status:raw[i],path:raw[i+1]});
  return {base_sha:base,head_sha:head,files,diff:includeDiff?await run(['diff','--no-ext-diff','--no-textconv','--no-renames',base,head,'--']):''};
 });}
 delta(project:string,from:string,to:string){return this.repository(project,async run=>{
  const base=await this.sha(run,from),head=await this.sha(run,to);const cache=resolve(this.root,'packages');await mkdir(cache,{recursive:true,mode:0o700});
  const path=resolve(cache,`${project}-${base}-${head}.zip`);
  if(!existsSync(path)){
   const temporary=path+'.tmp';
   try{await new Promise<void>((ok,fail)=>{
    const child=spawn(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),[resolve('scripts/git-delta.py'),base,head,temporary],{cwd:resolve(this.root,project),windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.resume();const timer=setTimeout(()=>child.kill(),3600000);
    child.once('error',()=>{clearTimeout(timer);fail(new Problem(503,'DELTA_UNAVAILABLE','Для пакетов обновления установите Python 3 на сервере D2D'));});child.once('close',code=>{clearTimeout(timer);code===0?ok():fail(new Problem(422,'DELTA_UNSAFE','Нельзя собрать обновление: проверьте пути, типы файлов и доступность версий'));});
   });await rename(temporary,path);}finally{await rm(temporary,{force:true});}
  }
  const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return {path,sha256:hash.digest('hex'),base_sha:base,head_sha:head};
 });}
 async revert(project:string,ref:string,expected:string,target:string,branch:string,a:Actor){
  await mkdir(this.root,{recursive:true,mode:0o700});const directory=await mkdtemp(resolve(this.root,'revert-'));
  try{
   const run=(args:string[])=>this.run(directory,args,{GIT_AUTHOR_NAME:a.name.replace(/[\r\n<>]/g,' '),GIT_AUTHOR_EMAIL:`d2d-${a.userId}@local.invalid`,GIT_COMMITTER_NAME:a.name.replace(/[\r\n<>]/g,' '),GIT_COMMITTER_EMAIL:`d2d-${a.userId}@local.invalid`});
   await run(['clone','--no-checkout',`${this.git.options.url}/${this.git.repo(project)}.git`,'.']);
   const sha=await this.sha(run,/^[a-f0-9]{40,64}$/.test(ref)?ref:'origin/'+ref);if(sha!==expected)throw new Problem(409,'GIT_CHANGED','Ветка изменилась. Прочитайте новые изменения перед откатом.');
   const remoteBranch=await run(['branch','-r','--list','origin/'+branch]);
   if(remoteBranch.trim()&&ref!==branch)throw new Problem(409,'WORK_BRANCH_REQUIRED','Ваша рабочая ветка уже существует. Выберите её перед откатом.');
   await run(['checkout','-B',branch,sha]);await run(['merge-base','--is-ancestor',target,'HEAD']);
   const parents=(await run(['rev-list','--parents','-n','1',target])).trim().split(' ');
   await run(['revert','--no-commit',...(parents.length>2?['-m','1']:[]),target]);
   await run(['commit','-m',`Откат ${target.slice(0,12)}: ${a.name.replace(/[\r\n]/g,' ')}`]);
   const commit=(await run(['rev-parse','HEAD'])).trim();await run(['push','origin',`HEAD:refs/heads/${branch}`]);return {commit_sha:commit,branch};
  }finally{const absolute=resolve(directory),root=resolve(this.root);if(!absolute.startsWith(root+'/')&&!absolute.startsWith(root+'\\'))throw new Error('Invalid Git workspace');await rm(absolute,{recursive:true,force:true});}
 }
}
export async function recordOwnership(tx:SQL,project:string,sha:string,a:Actor,w:any){
 await tx.query('INSERT INTO git_ownership VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[project,sha,a.id,a.userId,w.id,w.generation,Date.now()]);
}
