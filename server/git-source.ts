import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readdir,rm,copyFile,lstat,chmod} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import type {Forgejo} from './forgejo.ts';
import {extractArchive} from './archives.ts';
import type {Actor} from './model.ts';
import {Problem} from './security.ts';
import {safeSourcePath} from './file-upload.ts';

export interface UploadTarget {branch:string;from:string;expected_head:string;new_branch:boolean;path:string;message:string;}
export async function commitFiles(git:Forgejo,project:string,input:{directory?:string;files?:{path:string;size:number}[];archive?:string;root?:string},workRoot:string,target:UploadTarget,actor:Actor){
 safeSourcePath(target.path,true);
 await mkdir(workRoot,{recursive:true,mode:0o700});const directory=await mkdtemp(resolve(workRoot,'files-'));
 const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'3',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from(git.options.owner+':'+git.options.token).toString('base64'),GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:resolve(directory,'disabled-hooks'),GIT_CONFIG_KEY_2:'core.fsmonitor',GIT_CONFIG_VALUE_2:'false'};
 const run=(args:string[])=>new Promise<string>((ok,fail)=>{const child=spawn('git',args,{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>{if(out.length<100000)out+=c;});child.stderr.resume();const t=setTimeout(()=>child.kill(),3600000);child.once('error',()=>{clearTimeout(t);fail(new Problem(503,'GIT_UNAVAILABLE','Git недоступен'));});child.once('close',code=>{clearTimeout(t);if(code===0)ok(out.trim());else fail(new Problem(409,'GIT_UPLOAD_CONFLICT','Git отклонил запись: проверьте ветку, конфликт путей или новый коммит перед повтором'));});});
 try{
  await run(['check-ref-format','--branch',target.branch]);
  await run(['clone','--no-checkout',`${git.options.url}/${git.repo(project)}.git`,'.']);
  const branches=(await run(['for-each-ref','--format=%(refname:short)','refs/remotes/origin'])).split('\n');
  const exists=branches.includes('origin/'+target.branch),hasCommits=branches.some(b=>b&&b!=='origin/HEAD');
  if(target.new_branch&&exists)throw new Problem(409,'BRANCH_EXISTS','Ветка уже существует. Выберите её или укажите другое имя');
  if(!target.new_branch&&!exists&&hasCommits)throw new Problem(409,'BRANCH_REQUIRED','Выбранная ветка отсутствует. Включите создание новой ветки');
  if(hasCommits){
   const source=exists?'refs/remotes/origin/'+target.branch:target.from;
   const head=await run(['rev-parse','--verify','--end-of-options',source+'^{commit}']);
   if(!target.expected_head||head!==target.expected_head)throw new Problem(409,'GIT_CHANGED','Ветка изменилась после открытия загрузки. Обновите данные и повторите');
   await run(['checkout','-B',target.branch,head]);
  }else{
   if(target.expected_head)throw new Problem(409,'GIT_CHANGED','Репозиторий пуст. Откройте загрузку заново');
   await run(['checkout','--orphan',target.branch]);
  }
  const stage=resolve(directory,'.d2d-stage');let files=input.files??[];
  if(input.archive){await mkdir(stage);await extractArchive(input.archive,stage,input.root??'');const walk=async(path:string,prefix=''):Promise<{path:string;size:number}[]>=>{const result=[];for(const entry of await readdir(path,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())result.push(...await walk(resolve(path,entry.name),name+'/'));else result.push({path:name,size:0});}return result;};files=await walk(stage);}
  for(const [index,file] of files.entries()){
   const relative=(target.path?target.path+'/':'')+safeSourcePath(file.path);safeSourcePath(relative);
   if(relative.split('/')[0].toLowerCase()==='.d2d-stage')throw new Problem(422,'RESERVED_PATH','Имя .d2d-stage зарезервировано для загрузки');
   // Never traverse a symlink already committed to the repository.
   let parent=directory;for(const part of relative.split('/')){parent=resolve(parent,part);try{if((await lstat(parent)).isSymbolicLink())throw new Problem(422,'UNSAFE_PATH','Загрузка через символические ссылки запрещена');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
   const dest=resolve(directory,relative);if(!dest.startsWith(directory+sep))throw new Problem(422,'UNSAFE_PATH','Путь вне проекта');await mkdir(dirname(dest),{recursive:true});
   const source=input.archive?resolve(stage,file.path):resolve(input.directory!,String(index));
   await copyFile(source,dest);if(input.archive)await chmod(dest,((await lstat(source)).mode&0o111)?0o755:0o644);
  }
  if(input.archive)await rm(stage,{recursive:true,force:true});
  await run(['add','--force','--all']);const changed=await run(['status','--porcelain']);
  if(changed)await run(['-c',`user.name=${actor.name.replace(/[\r\n<>]/g,' ')}`,'-c',`user.email=d2d-${actor.userId}@local.invalid`,'commit','-m',target.message]);
  if(!changed&&!hasCommits)throw new Problem(422,'EMPTY_UPLOAD','Нет файлов для первого коммита');
  const sha=await run(['rev-parse','HEAD']);
  // A lease compares the exact branch head; a concurrent commit cannot be overwritten, even by fast-forward.
  const expected=exists?target.expected_head:'';
  await run(['push',`--force-with-lease=refs/heads/${target.branch}:${expected}`,'origin',`HEAD:refs/heads/${target.branch}`]);
  if(!hasCommits){
   let repository:any;
   for(let attempt=0;attempt<50;attempt++){repository=await git.exists(project);if(repository&&!repository.empty)break;await new Promise(r=>setTimeout(r,100));}
   if(repository?.empty)throw new Problem(503,'GIT_INDEX_PENDING','Коммит отправлен; Git ещё обновляет индекс. Обновите историю перед повторной загрузкой');
   if(repository?.default_branch!==target.branch)await git.json(`/repos/${git.repo(project)}`,'PATCH',{default_branch:target.branch});
  }
  return {commit_sha:sha,branch:target.branch,changed:!!changed,files:files.length};
 }finally{if(!resolve(directory).startsWith(resolve(workRoot)+sep))throw new Error('Invalid upload workspace');await rm(directory,{recursive:true,force:true});}
}

export async function importSource(git:Forgejo,project:string,artifact:any,archive:string,workRoot:string,branch:string,actor:Actor,message:string){
  await mkdir(workRoot,{recursive:true,mode:0o700});const directory=await mkdtemp(resolve(workRoot,'import-'));
  const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from(git.options.owner+':'+git.options.token).toString('base64'),GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:resolve(directory,'disabled-hooks')};
  const run=(args:string[])=>new Promise<string>((ok,fail)=>{
    const child=spawn('git',args,{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk;});child.stderr.resume();
    const timer=setTimeout(()=>child.kill(),3600000);child.once('error',()=>{clearTimeout(timer);fail(new Problem(503,'GIT_UNAVAILABLE','Git недоступен на сервере'));});
    child.once('close',code=>{clearTimeout(timer);if(code===0)ok(output.trim());else fail(new Problem(409,'GIT_IMPORT_FAILED','Не удалось записать архив в Git. Проверьте состояние ветки перед повтором'));});
  });
  try{
    await run(['clone','--no-checkout',`${git.options.url}/${git.repo(project)}.git`,'.']);
    const heads=await run(['branch','-r']);
    if(heads){const remote=heads.split('\n').map(x=>x.trim()).find(x=>x===`origin/${branch}`);await run(['checkout','-B',branch,remote??'origin/'+(await git.exists(project)).default_branch]);}else await run(['checkout','--orphan',branch]);
    // All deletion stays inside the newly created private temporary checkout.
    for(const name of await readdir(directory))if(name!=='.git')await rm(resolve(directory,name),{recursive:true,force:true});
    await extractArchive(archive,directory,artifact.recipe.root);
    await run(['add','--force','--all']);
    const changed=await run(['status','--porcelain']);
    if(changed)await run(['-c',`user.name=${actor.name.replace(/[\r\n<>]/g,' ')}`,'-c',`user.email=d2d-${actor.userId}@local.invalid`,'commit','-m',message]);
    await run(['push','origin',`HEAD:refs/heads/${branch}`]);
    for(let attempt=0;attempt<30;attempt++){if(!(await git.exists(project))?.empty)break;await new Promise(r=>setTimeout(r,100));}
    return await run(['rev-parse','HEAD']);
  }finally{
    const target=resolve(directory),root=resolve(workRoot);if(!target.startsWith(root+'/')&&!target.startsWith(root+'\\'))throw new Error('Temporary checkout escaped work root');
    await rm(target,{recursive:true,force:true});
  }
}
