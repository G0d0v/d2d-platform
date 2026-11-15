import {mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Readable} from 'node:stream';
import {Problem} from './security.ts';

export const FILES_MEDIA='application/vnd.d2d.files-v1';
export function safeSourcePath(path:string,allowEmpty=false){
 if(allowEmpty&&path==='')return path;
 if(typeof path!=='string'||!path||path.length>1000||/[\\:\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))throw new Problem(422,'UNSAFE_PATH','Используйте относительный путь без .., обратных слешей и пустых частей');
 if(path.split('/').some(p=>['.git','node_modules','.env','id_rsa','id_ed25519'].includes(p.toLowerCase()))||/\.(pem|key)$/i.test(path))throw new Problem(422,'SENSITIVE_PATH','Не загружайте .git, node_modules, .env и приватные ключи. Файлы .env.example разрешены');
 return path;
}
// A bounded manifest followed by exact-length file streams. Files never enter a JSON/base64 body.
export async function receiveFiles(body:Readable,directory:string){
 const iterator=body[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
 async function take(size:number):Promise<Buffer>{
  while(!pending.length){const next=await iterator.next();if(next.done)throw new Problem(422,'INCOMPLETE_UPLOAD','Загрузка прервана: получены не все байты');pending=Buffer.from(next.value);}
  const part=pending.subarray(0,Math.min(size,pending.length));pending=pending.subarray(part.length);return part;
 }
 async function exact(size:number){const parts:Buffer[]=[];let n=0;while(n<size){const p=await take(size-n);parts.push(p);n+=p.length;}return Buffer.concat(parts);}
 const length=(await exact(4)).readUInt32BE();if(!length||length>4*1024*1024)throw new Problem(422,'MANIFEST_LIMIT','Описание загрузки не должно превышать 4 МиБ');
 let manifest:any;try{manifest=JSON.parse((await exact(length)).toString('utf8'));}catch{throw new Problem(422,'INVALID_MANIFEST','Некорректное описание файлов');}
 if(!manifest||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>10000)throw new Problem(422,'FILE_COUNT','Выберите от 1 до 10 000 файлов');
 const seen=new Set<string>();const files=manifest.files.map((f:any)=>{
  const path=safeSourcePath(f?.path);if(!Number.isSafeInteger(f.size)||f.size<0)throw new Problem(422,'INVALID_SIZE','Некорректный размер файла');
  const key=path.toLowerCase();if(seen.has(key))throw new Problem(422,'DUPLICATE_PATH','В загрузке повторяются пути файлов');seen.add(key);return {path,size:f.size};
 });
 for(const f of files)for(const [i] of f.path.split('/').entries())if(seen.has(f.path.split('/').slice(0,i).join('/').toLowerCase()))throw new Problem(422,'PATH_CONFLICT','Файл не может одновременно быть папкой');
 await mkdir(directory,{recursive:true,mode:0o700});
 for(const [index,file] of files.entries()){
  const handle=await open(resolve(directory,String(index)),'wx',0o600);
  try{let received=0;while(received<file.size){const part=await take(file.size-received);await handle.writeFile(part);received+=part.length;}}finally{await handle.close();}
 }
 if(pending.length||!(await iterator.next()).done)throw new Problem(422,'EXTRA_UPLOAD_DATA','После файлов обнаружены лишние данные');
 return files as {path:string;size:number}[];
}
