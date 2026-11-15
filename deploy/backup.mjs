import pg from 'pg';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {access,mkdir,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
const destination='/var/backups/d2d';
await mkdir(destination,{recursive:true,mode:0o700});
const name=join(destination,'d2d-'+new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15));
const run=(cmd,args)=>new Promise((resolve,reject)=>{
 const child=spawn(cmd,args,{stdio:['ignore','ignore','pipe']});let err='';child.stderr.on('data',data=>err+=data);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`${cmd} failed (${code}): ${err}`)));
});
const client=new pg.Client({connectionString:process.env.DATABASE_URL});let stopped=false;
await client.connect();
try{
 await client.query('BEGIN');await client.query('SELECT id FROM control WHERE id=1 FOR UPDATE');
 let hasForgejo=false;try{await access('/etc/forgejo/app.ini');hasForgejo=true;}catch{}
 if(hasForgejo){await run('systemctl',['stop','forgejo']);stopped=true;}
 const dump=spawn('runuser',['-u','postgres','--','pg_dump','-Fc','d2d'],{stdio:['ignore','pipe','inherit']});
 const completed=new Promise((resolve,reject)=>{dump.once('error',reject);dump.once('close',code=>code===0?resolve():reject(new Error('pg_dump failed')));});
 await Promise.all([pipeline(dump.stdout,createWriteStream(name+'.pg.dump',{flags:'wx',mode:0o600})),completed]);
 const paths=['var/lib/d2d','etc/d2d.env','etc/nginx/sites-available/d2d','etc/systemd/system/d2d.service'];
 if(hasForgejo)paths.push('var/lib/forgejo','etc/forgejo','etc/systemd/system/forgejo.service');
 await run('tar',['--exclude=*.upload','--exclude=*/git-work/*','--exclude=*/git-cache/*','--exclude=*/uploads/*','-czf',name+'.files.tar.gz','-C','/',...paths]);
 await client.query('COMMIT');
 console.log('Backup complete: '+name);
}catch(e){await client.query('ROLLBACK');throw e;}
finally{if(stopped)await run('systemctl',['start','forgejo']);await client.end();}
for(const file of await readdir(destination))if(/^d2d-[0-9-]+\.(pg\.dump|files\.tar\.gz)$/.test(file)){
 const target=join(destination,file);if(Date.now()-(await stat(target)).mtimeMs>3*86400000)await rm(target);
}
