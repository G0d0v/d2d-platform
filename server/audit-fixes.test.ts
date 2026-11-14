import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from './db.ts';
import { createApp } from './app.ts';

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
