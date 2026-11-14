import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export interface TokenVault {seal(value:string,context:string):string;open(value:string,context:string):string;}
export async function tokenVault(directory:string):Promise<TokenVault>{
 await mkdir(resolve(directory),{recursive:true,mode:0o700});const path=resolve(directory,'token-vault.key');
 let key:Buffer;
 try{key=await readFile(path);}catch(e:any){if(e.code!=='ENOENT')throw e;try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error:any){if(error.code!=='EEXIST')throw error;}key=await readFile(path);}
 if(key.length!==32)throw new Error('Invalid token vault key');
 return {
  seal(value,context){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(context));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [nonce,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');},
  open(value,context){const [nonce,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64url'));const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(context));cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');}
 };
}
