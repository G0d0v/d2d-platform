import {spawn} from 'node:child_process';
import {mkdir,rename,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Problem} from './security.ts';

const archiveLocks=new Map<string,Promise<string>>();
export async function archiveDelta(blobs:string,project:string,before:any,after:any){
 const root=resolve(blobs,'deltas'),path=resolve(root,`${project}-${before.sha256}-${after.sha256}.zip`);
 if(archiveLocks.has(path))return archiveLocks.get(path)!;
 const operation=(async()=>{
  await mkdir(root,{recursive:true,mode:0o700});if(existsSync(path))return path;
  const temporary=path+'.tmp';
  try{
   await new Promise<void>((ok,fail)=>{
    const child=spawn(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),[resolve('scripts/git-delta.py'),'--archives',resolve(blobs,before.sha256+'.zip'),resolve(blobs,after.sha256+'.zip'),before.recipe.root,after.recipe.root,before.sha256,after.sha256,temporary],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>child.kill(),3600000);child.once('error',()=>{clearTimeout(timer);fail(new Problem(503,'DELTA_UNAVAILABLE','Для пакета обновления нужен Python 3'));});child.once('close',code=>{clearTimeout(timer);code===0?ok():fail(new Problem(422,'DELTA_UNSAFE','Не удалось проверить архивы обновления'));});
   });await rename(temporary,path);return path;
  }finally{await rm(temporary,{force:true});}
 })();archiveLocks.set(path,operation);try{return await operation;}finally{archiveLocks.delete(path);}
}
