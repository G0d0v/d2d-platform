import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Forgejo} from './forgejo.ts';
import {extractArchive} from './archives.ts';
import type {Actor} from './model.ts';
import {Problem} from './security.ts';

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
