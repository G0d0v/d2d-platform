import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './db.ts';
import { createApp } from './app.ts';

test('первый публичный аккаунт защищён кодом настройки',async()=>{
  const db=await database(),app=await createApp({db,setupToken:'private-setup-code'});
  try{const payload={login:'owner',display_name:'Owner',password:'safe-test-password-123'};
    const blocked=await app.inject({method:'POST',url:'/api/v1/auth/register',payload});assert.equal(blocked.statusCode,403);
    const allowed=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{...payload,setup_token:'private-setup-code'}});assert.equal(allowed.statusCode,200,allowed.body);
  }finally{await app.close();await db.close();}
});

test('запрос передачи можно отклонить, отменить и принять с новым поколением',async()=>{
  const db=await database(),app=await createApp({db,registration:'open'});
  async function call(c:any,method:any,path:string,body?:any){return app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),headers:{...c,'idempotency-key':randomUUID()}});}
  async function account(login:string){const r=await call({},'POST','/auth/register',{login,display_name:login,password:'safe-test-password-123'});return {cookie:`d2d_session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf};}
  try{const owner=await account('owner'),other=await account('other');const p=(await call(owner,'POST','/projects',{name:'Передача',slug:'transfer'})).json().project;
    await call(owner,'POST',`/projects/${p.id}/members`,{login:'other',role:'developer'});const w=(await call(owner,'POST',`/projects/${p.id}/work-sessions`,{note:'Работа'})).json().work;
    for(const action of ['reject','cancel','accept']){const h=(await call(other,'POST',`/work-sessions/${w.id}/transfer-requests`,{note:'Продолжу'})).json();
      const result=await call(action==='cancel'?other:owner,'POST',`/transfer-requests/${h.id}/resolve`,{action,generation:w.generation,summary:'Контекст сохранён'});assert.equal(result.statusCode,200,result.body);
    }
    const current=(await call(owner,'GET',`/projects/${p.id}`)).json();assert.ok(current.project.work.generation>w.generation);assert.equal(current.handoffs.length,0);
    assert.equal((await call(owner,'POST',`/work-sessions/${w.id}/finish`,{generation:w.generation,summary:'Устарело'})).statusCode,409);
  }finally{await app.close();await db.close();}
});

test('исправления аудита: полный поиск, контекст, 501 задача, роли, архив и истечение агента',async()=>{
  const db=await database();const app=await createApp({db,registration:'open'});
  async function call(c:any,method:any,path:string,body?:any,headers={}) {return app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),headers:{...c,'idempotency-key':randomUUID(),...headers}});}
  async function user(login:string) {const r=await call({},'POST','/auth/register',{login,display_name:login,password:'safe-test-password-123'});assert.equal(r.statusCode,200,r.body);return {headers:{cookie:`d2d_session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf},id:r.json().user.id};}
  try {
    const a=await user('owner'),b=await user('colleague');
    const p=(await call(a.headers,'POST','/projects',{name:'Искомый старый проект',slug:'old-project'})).json().project;
    for(let i=0;i<52;i++) await db.query('INSERT INTO projects (id,slug,name,owner_id,created_at) VALUES ($1,$2,$2,$3,$4)',[randomUUID(),`new-${i}`,a.id,Date.now()+i+1]).then(async()=>{});
    // The extra projects must have actual membership, as they would after creation through the API.
    await db.query("INSERT INTO members SELECT id,$1,'admin' FROM projects WHERE id<>$2",[a.id,p.id]);
    let w=(await call(a.headers,'POST',`/projects/${p.id}/work-sessions`,{note:'Первая сессия'})).json().work;
    assert.equal((await call(a.headers,'GET','/projects?q=Искомый')).json().pagination.total,1);
    assert.equal((await call(a.headers,'GET','/me/work')).json().data[0].id,p.id);
    await call(a.headers,'POST',`/work-sessions/${w.id}/finish`,{generation:w.generation,summary:'Продолжить с шага 7'});
    assert.equal((await call(a.headers,'GET',`/projects/${p.id}/agent-context`)).json().last_handoff.summary,'Продолжить с шага 7');
    w=(await call(a.headers,'POST',`/projects/${p.id}/work-sessions`,{note:'Новая сессия'})).json().work;
    await db.query(`INSERT INTO tasks (id,project_id,title,created_by,created_at,updated_at) SELECT 'task-'||n,$1,'Задача '||n,$2,n,n FROM generate_series(1,501) n`,[p.id,a.id]);
    const page=(await call(a.headers,'GET',`/projects/${p.id}/tasks?page=11`)).json();assert.equal(page.pagination.total,501);assert.equal(page.data[0].id,'task-1');
    const edit=await call(a.headers,'PATCH','/tasks/task-1',{generation:w.generation,title:'Исправленная задача',description:'Новые критерии',priority:'high'},{'if-match':'1'});assert.equal(edit.statusCode,200,edit.body);assert.equal(edit.json().task.title,'Исправленная задача');
    assert.equal((await call(a.headers,'PATCH','/tasks/task-1',{generation:w.generation,archived:true},{'if-match':'1'})).statusCode,412);
    assert.equal((await call(a.headers,'PATCH','/tasks/task-1',{generation:w.generation,archived:true},{'if-match':'2'})).statusCode,200);
    assert.equal((await call(a.headers,'GET',`/projects/${p.id}/tasks?archived=true`)).json().pagination.total,1);
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/members/update`,{user_id:a.id,role:'viewer'})).json().error.code,'LAST_ADMIN');
    await call(a.headers,'POST',`/projects/${p.id}/members`,{login:'colleague',role:'developer'});
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/members/update`,{user_id:b.id,remove:true})).statusCode,200);
    assert.equal((await call(b.headers,'GET',`/projects/${p.id}`)).statusCode,404);
    await call(a.headers,'POST',`/work-sessions/${w.id}/finish`,{generation:w.generation,summary:'Агент следующий'});
    const agent=(await call(a.headers,'POST',`/projects/${p.id}/agents`,{name:'test',scopes:['write'],hours:1})).json();const ac={authorization:'Bearer '+agent.token};
    const aw=(await call(ac,'POST',`/projects/${p.id}/work-sessions`,{note:'Агент',minutes:120})).json().work;
    assert.ok(aw.expires_at<=agent.expires_at);
    await db.query('UPDATE agents SET expires_at=$1 WHERE id=$2',[Date.now()-1,agent.id]);
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/work-sessions`,{note:'Продолжает человек'})).statusCode,200);
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/archive`,{})).statusCode,200);
    assert.equal((await call(a.headers,'GET','/projects?archived=true')).json().pagination.total,1);
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/tasks`,{title:'Нет'})).json().error.code,'PROJECT_ARCHIVED');
    assert.equal((await call(a.headers,'POST',`/projects/${p.id}/restore`,{})).statusCode,200);
    const invitation=(await call(a.headers,'POST','/invites',{project_id:p.id,role:'viewer'})).json();
    const invited=await call({},'POST','/auth/register',{login:'invited',display_name:'invited',password:'safe-test-password-123',invite:invitation.invite});assert.equal(invited.statusCode,200,invited.body);
    assert.equal((await db.query('SELECT role FROM members WHERE project_id=$1 AND user_id=$2',[p.id,invited.json().user.id])).rows[0].role,'viewer');
    const security=await call(a.headers,'POST','/me/security',{action:'recovery',password:'safe-test-password-123'});assert.equal(security.statusCode,200,security.body);assert.ok(security.json().recovery_code);
  } finally {await app.close();await db.close();}
});
