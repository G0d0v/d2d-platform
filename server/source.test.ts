import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,dirname,basename} from 'node:path';
import {database} from './db.ts';import {createApp} from './app.ts';import {inspectArchive} from './archives.ts';
export function zipFiles(files:Record<string,string>,mode=0o100644){
  const parts:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,value] of Object.entries(files)){
    const filename=Buffer.from(name),data=Buffer.from(value);let crc=0xffffffff;for(const byte of data){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(filename.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x0314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE((mode*65536)>>>0,38);c.writeUInt32LE(offset,42);parts.push(h,filename,data);central.push(c,filename);offset+=h.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
test('ZIP: запрещает обход каталогов, ссылки, секреты и повреждённые архивы',async()=>{
  for(const buffer of [zipFiles({'../outside.txt':'bad'}),zipFiles({'project/.env':'SECRET=123'}),zipFiles({'link':'target'},0o120777),Buffer.from('not zip')])await assert.rejects(inspectArchive(buffer));
  const corrupt=zipFiles({'file.txt':'original'});corrupt[30+Buffer.byteLength('file.txt')]=65;await assert.rejects(inspectArchive(corrupt),/Контрольная сумма/);
  const good=await inspectArchive(zipFiles({'sample/package.json':'{"scripts":{"start":"node index.js"}}','sample/index.js':'console.log("ok")'}));assert.equal(good.root,'sample/');assert.equal(good.files.length,2);
});
test('исходный проект: загрузка, просмотр, изоляция, проверяемая установка и закрепление сервера',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'d2d-source-test-'));const db=await database();const app=await createApp({db,registration:'open',dataDir:directory,origin:'https://d2d.example.test'});
  async function call(c:any,method:any,path:string,body?:any,headers={}){return app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),headers:{...c,'idempotency-key':randomUUID(),...headers}});}
  async function account(login:string){const r=await call({},'POST','/auth/register',{login,display_name:login,password:'source-test-password-123'});return {cookie:`d2d_session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf};}
  try{
    const a=await account('owner'),b=await account('outsider');const p=(await call(a,'POST','/projects',{name:'Исходный проект',slug:'source'})).json().project;
    const zip=zipFiles({'sample/Dockerfile':'FROM busybox:1.37\nCMD ["httpd","-f","-p","3000"]\n','sample/README.md':'# Example'});
    const upload=await call(a,'POST',`/projects/${p.id}/source`,zip,{'content-type':'application/zip','x-filename':'sample.zip'});assert.equal(upload.statusCode,200,upload.body);const f=upload.json().artifact;assert.equal(f.recipe.type,'dockerfile');
    const duplicate=await call(a,'POST',`/projects/${p.id}/source`,zip,{'content-type':'application/zip'});assert.equal(duplicate.json().artifact.id,f.id);
    assert.equal((await call(b,'GET',`/artifacts/${f.id}/download`)).statusCode,404);
    const download=await call(a,'GET',`/artifacts/${f.id}/download`);assert.equal(download.statusCode,200,download.body);assert.deepEqual(download.rawPayload,zip);
    assert.equal((await call(a,'GET',`/artifacts/${f.id}/file?path=sample%2FREADME.md`)).json().content,'# Example');
    const issue=await call(a,'POST',`/artifacts/${f.id}/installations`,{});assert.equal(issue.statusCode,200,issue.body);const job=issue.json(),raw=job.command.match(/D2D_INSTALL_TOKEN='([^']+)'/)[1];assert.ok(raw);
    const install=(method:any,path:string,payload?:any)=>app.inject({method,url:`/api/install/${job.id}/${path}`,payload,headers:{authorization:'Bearer '+raw}});
    const claim=await install('POST','claim',{host:'test-server'});assert.equal(claim.statusCode,200,claim.body);assert.equal(claim.json().sha256,f.sha256);
    assert.equal((await install('POST','claim',{host:'different-server'})).statusCode,409);
    assert.deepEqual((await install('GET','archive')).rawPayload,zip);
    assert.equal((await call(a,'PATCH',`/artifacts/${f.id}/recipe`,{type:'dockerfile',port:8080,path:''})).statusCode,409);
    assert.equal((await install('POST','result',{host:'test-server',state:'installed',message:'Containers healthy'})).statusCode,200);
    assert.equal((await install('POST','result',{host:'test-server',state:'failed',message:'late'})).statusCode,409);
    assert.equal((await call(a,'GET',`/projects/${p.id}/source`)).json().installations[0].state,'installed');
    const stored=(await db.query('SELECT token_hash FROM installations WHERE id=$1',[job.id])).rows[0].token_hash;assert.notEqual(stored,raw);
    await db.query('UPDATE installations SET expires_at=$1 WHERE id=$2',[Date.now()-1,job.id]);assert.equal((await install('GET','archive')).statusCode,401);
  }finally{await app.close();await db.close();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('d2d-source-test-'));await rm(target,{recursive:true,force:true});}
});
