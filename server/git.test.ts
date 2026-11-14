import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {database} from './db.ts';
import {createApp} from './app.ts';
import {Forgejo} from './forgejo.ts';

test('Forgejo принимает только loopback, без конфигурации Git выключен',async()=>{
  assert.throws(()=>new Forgejo({url:'https://example.com',token:'x',owner:'service'}));
  const db=await database(),app=await createApp({db,registration:'open'});
  try{const r=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{login:'gitowner',display_name:'Git',password:'test-git-password-123'}});const cookie=`d2d_session=${r.cookies[0].value}`;
    const caps=(await app.inject({url:'/api/v1/capabilities',headers:{cookie}})).json();assert.equal(caps.forgejo,false);assert.equal(caps.git_write,false);
  }finally{await app.close();await db.close();}
});

test('Git push сериализован с передачей, старое поколение и read не проходят',async()=>{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const upstream=createServer(async(req,res)=>{
    if(req.url?.startsWith('/api/v1/repos/')){res.setHeader('Content-Type','application/json');res.end('{"name":"test"}');return;}
    req.resume();entered();await gate;res.setHeader('Content-Type','application/x-git-receive-pack-result');res.end('0000');
  });await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const db=await database(),app=await createApp({db,registration:'open',forgejo:{url:`http://127.0.0.1:${(upstream.address() as any).port}`,token:'upstream-secret',owner:'service'}});
  async function call(c:any,method:any,path:string,payload?:any,headers={}){return app.inject({method,url:'/api/v1'+path,payload,headers:{...c,'idempotency-key':randomUUID(),...headers}});}
  try{
    const r=await call({},'POST','/auth/register',{login:'publisher',display_name:'Publisher',password:'test-git-password-123'}),owner={cookie:`d2d_session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf};
    const p=(await call(owner,'POST','/projects',{name:'Git race',slug:'git-race'})).json().project;
    const agent=(await call(owner,'POST',`/projects/${p.id}/agents`,{name:'writer',scopes:['read','write'],hours:1})).json(),headers={authorization:'Bearer '+agent.token};
    const w=(await call(headers,'POST',`/projects/${p.id}/work-sessions`,{note:'Push'})).json().work;
    const push=()=>app.inject({method:'POST',url:`/git/${p.id}.git/git-receive-pack`,payload:Buffer.from('0000'),headers:{...headers,'content-type':'application/x-git-receive-pack-request','x-work-generation':String(w.generation)}});
    const sending=push();await started;let transferred=false;
    const handoff=call(owner,'POST',`/work-sessions/${w.id}/handoff`,{generation:w.generation,to_user_id:r.json().user.id,summary:'After push'}).then(r=>{transferred=true;return r;});
    await new Promise(r=>setTimeout(r,50));assert.equal(transferred,false);release();assert.equal((await sending).statusCode,200);assert.equal((await handoff).statusCode,200);assert.equal((await push()).statusCode,409);
    await db.query('UPDATE agents SET scopes=$1 WHERE id=$2',[JSON.stringify(['read']),agent.id]);assert.equal((await push()).statusCode,403);
  }finally{release();await app.close();await db.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

test('настоящий Forgejo: clone/push, ветки, PR, review, merge, релиз и установочная версия',{skip:!process.env.TEST_FORGEJO_TOKEN},async()=>{
  const gitOptions={url:process.env.TEST_FORGEJO_URL??'http://127.0.0.1:3001',token:process.env.TEST_FORGEJO_TOKEN!,owner:process.env.TEST_FORGEJO_OWNER??'d2d-service'};
  const git=new Forgejo(gitOptions),directory=await mkdtemp(join(tmpdir(),'d2d-git-test-')),db=await database(),app=await createApp({db,registration:'open',dataDir:join(directory,'data'),forgejo:gitOptions});
  const checkout=join(directory,'checkout');await mkdir(checkout);
  await app.listen({port:0,host:'127.0.0.1'});const origin=`http://127.0.0.1:${(app.server.address() as any).port}`;let projectId='',uploadedProject='';
  async function call(c:any,method:any,path:string,payload?:any,headers={}){const r=await app.inject({method,url:'/api/v1'+path,payload,headers:{...c,'idempotency-key':randomUUID(),...headers}});return r;}
  async function user(login:string){const r=await call({},'POST','/auth/register',{login,display_name:login,password:'test-git-password-123'});assert.equal(r.statusCode,200,r.body);return {id:r.json().user.id,headers:{cookie:`d2d_session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf}};}
  let token='',gen=0;
  function run(args:string[],expected=0){return new Promise<string>((ok,fail)=>{
    const child=spawn('git',args,{cwd:checkout,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from('d2d:'+token).toString('base64'),GIT_CONFIG_KEY_1:'http.extraHeader',GIT_CONFIG_VALUE_1:'X-Work-Generation: '+gen}});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.once('error',fail);child.once('exit',code=>{try{assert.equal(code,expected,err);ok(out.trim());}catch(e){fail(e);}});
  });}
  try{
    const owner=await user('realowner'),reviewer=await user('reviewer');
    const p=(await call(owner.headers,'POST','/projects',{name:'Forgejo integration test',slug:'real-git'})).json().project;projectId=p.id;
    assert.equal((await call(owner.headers,'POST',`/projects/${p.id}/members`,{login:'reviewer',role:'developer'})).statusCode,200);
    assert.equal((await call(owner.headers,'POST',`/projects/${p.id}/git`,{})).statusCode,200);
    const writer=(await call(owner.headers,'POST',`/projects/${p.id}/agents`,{name:'Real Git',scopes:['read','write'],hours:1})).json();token=writer.token;const agent={authorization:'Bearer '+token};
    const w=(await call(agent,'POST',`/projects/${p.id}/work-sessions`,{note:'Real Git test'})).json().work;gen=w.generation;
    await run(['clone',`${origin}/git/${p.id}.git`,'.']);await run(['checkout','--orphan','main']);
    await writeFile(join(checkout,'README.md'),'# Initial code\n');await writeFile(join(checkout,'Dockerfile'),'FROM busybox:1.37\nCMD ["httpd","-f","-p","3000"]\n');
    await run(['add','README.md','Dockerfile']);await run(['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','Initial']);await run(['push','origin','main']);
    let status=await call(agent,'GET',`/projects/${p.id}/git`);for(let attempt=0;attempt<30&&status.json().repository.empty;attempt++){await new Promise(r=>setTimeout(r,100));status=await call(agent,'GET',`/projects/${p.id}/git`);}assert.equal(status.json().repository.empty,false,status.body);
    const tree=await call(agent,'GET',`/projects/${p.id}/git/tree?ref=main`);assert.equal(tree.statusCode,200,tree.body);assert.equal(tree.json().entries.length,2);
    assert.equal((await call(agent,'GET',`/projects/${p.id}/git/raw?ref=main&path=README.md`)).body,'# Initial code\n');
    await run(['checkout','-b',w.branch]);await writeFile(join(checkout,'README.md'),'# Updated code\n');await run(['add','README.md']);await run(['-c','user.name=Test','-c','user.email=test@local.invalid','commit','-m','Update']);await run(['push','origin',w.branch]);
    const meta=await call(agent,'GET',`/projects/${p.id}/git/file-metadata?ref=${encodeURIComponent(w.branch)}`);assert.equal(meta.statusCode,200,meta.body);assert.ok(meta.json().files.find((f:any)=>f.path==='README.md').added_at);
    const history=await call(agent,'GET',`/projects/${p.id}/git/file-history?ref=${encodeURIComponent(w.branch)}&path=README.md`);assert.equal(history.statusCode,200,history.body);assert.equal(history.json().commits.length,2);assert.equal(history.json().commits[0].owned_by_me,true);
    const change=await call(agent,'GET',`/projects/${p.id}/git/commit-diff?sha=${history.json().commits[0].sha}`);assert.equal(change.statusCode,200,change.body);assert.match(change.body,/^-# Initial code/m);assert.match(change.body,/^\+# Updated code/m);
    const h={'x-work-generation':String(gen)},pr=await call(agent,'POST',`/projects/${p.id}/git/pulls`,{title:'Review code',body:'Verified locally',head:w.branch,base:'main'},h);assert.equal(pr.statusCode,200,pr.body);const pull=pr.json().pull;
    const diff=await call(agent,'GET',`/projects/${p.id}/git/diff?number=${pull.number}`);assert.equal(diff.statusCode,200,diff.body);assert.match(diff.body,/Updated code/);
    const comment=await call(reviewer.headers,'POST',`/projects/${p.id}/comments`,{type:'pull',subject:String(pull.number),body:'Проверка строки',file_path:'README.md',head_sha:pull.head.sha,line:1,side:'after'});assert.equal(comment.statusCode,200,comment.body);
    const staleComment=await call(reviewer.headers,'POST',`/projects/${p.id}/comments`,{type:'pull',subject:String(pull.number),body:'Устаревший diff',file_path:'README.md',head_sha:'0'.repeat(40),line:1,side:'after'});assert.equal(staleComment.statusCode,409);
    const review={number:pull.number,head_sha:pull.head.sha,state:'approved',body:'Reviewed'};
    assert.equal((await call(owner.headers,'POST',`/projects/${p.id}/git/reviews`,review)).statusCode,403);
    assert.equal((await call(reviewer.headers,'POST',`/projects/${p.id}/git/reviews`,review)).statusCode,200);
    const handoff=await call(owner.headers,'POST',`/work-sessions/${w.id}/handoff`,{generation:gen,to_user_id:owner.id,summary:'Merge reviewed code'});assert.equal(handoff.statusCode,200,handoff.body);const next=handoff.json().work;
    await run(['push','origin','HEAD:refs/heads/late'],128);
    const merged=await call(owner.headers,'POST',`/projects/${p.id}/git/merge`,{number:pull.number,head_sha:pull.head.sha},{'x-work-generation':String(next.generation)});assert.equal(merged.statusCode,200,merged.body);
    const release=await call(owner.headers,'POST',`/projects/${p.id}/git/releases`,{tag:'v-test',name:'Test release',body:'Test',ref:'main'},{'x-work-generation':String(next.generation)});assert.equal(release.statusCode,200,release.body);
    const snapshot=await call(owner.headers,'POST',`/projects/${p.id}/git/snapshot`,{ref:'v-test'});assert.equal(snapshot.statusCode,200,snapshot.body);const f=snapshot.json().artifact;assert.match(f.commit_sha,/^[a-f0-9]{40}$/);assert.equal(f.recipe.type,'dockerfile');
    const issue=await call(owner.headers,'POST',`/artifacts/${f.id}/installations`,{});assert.equal(issue.statusCode,200,issue.body);
    const raw=issue.json().command.match(/D2D_INSTALL_TOKEN='([^']+)'/)[1],claim=await app.inject({method:'POST',url:`/api/install/${issue.json().id}/claim`,payload:{host:'test-git-server'},headers:{authorization:'Bearer '+raw}});assert.equal(claim.statusCode,200,claim.body);
    const imported=await call(owner.headers,'POST',`/projects/${p.id}/git/import`,{artifact_id:f.id,message:'Import existing snapshot'},{'x-work-generation':String(next.generation)});assert.equal(imported.statusCode,200,imported.body);
    const currentHistory=(await call(owner.headers,'GET',`/projects/${p.id}/git/file-history?ref=${encodeURIComponent(next.branch)}&path=README.md`)).json();
    const reverted=await call(owner.headers,'POST',`/projects/${p.id}/git/revert`,{sha:pull.head.sha,ref:next.branch,expected_head:currentHistory.ref,generation:next.generation},{'x-work-generation':String(next.generation)});assert.equal(reverted.statusCode,200,reverted.body);
    assert.equal((await call(owner.headers,'GET',`/projects/${p.id}/git/raw?ref=${encodeURIComponent(reverted.json().branch)}&path=README.md`)).body,'# Initial code\n');
    const p2=(await call(owner.headers,'POST','/projects',{name:'Auto Git ZIP',slug:'auto-git-zip'})).json().project;uploadedProject=p2.id;
    await run(['archive','--format=zip','-o',join(directory,'upload.zip'),'HEAD']);
    const auto=await call(owner.headers,'POST',`/projects/${p2.id}/source`,await readFile(join(directory,'upload.zip')),{'content-type':'application/zip'});assert.equal(auto.statusCode,200,auto.body);assert.match(auto.json().git.commit_sha,/^[a-f0-9]{40}$/);assert.equal(auto.json().git.branch,'main');
    assert.equal((await call(owner.headers,'GET',`/projects/${p2.id}/git/raw?ref=main&path=README.md`)).body,'# Updated code\n');

  }finally{if(uploadedProject)await git.json(`/repos/${git.repo(uploadedProject)}`,'DELETE');if(projectId)await git.json(`/repos/${git.repo(projectId)}`,'DELETE');await app.close();await db.close();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(target.includes('d2d-git-test-'));await rm(target,{recursive:true,force:true});}
});
