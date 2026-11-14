import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database} from './db.ts';
import {createApp} from './app.ts';

test('MCP: handshake, tools, scopes, изоляция, повтор намерения и отзыв',async()=>{
 const db=await database(),app=await createApp({db,registration:'open'});
 async function api(c:any,method:any,path:string,payload?:any){return app.inject({method,url:'/api/v1'+path,payload,headers:{...c,'idempotency-key':randomUUID()}});}
 try{
  const reg=await api({},'POST','/auth/register',{login:'mcpowner',display_name:'MCP Owner',password:'mcp-test-password-123'}),owner={cookie:`d2d_session=${reg.cookies[0].value}`,'x-csrf-token':reg.json().csrf};
  const project=(await api(owner,'POST','/projects',{name:'MCP project',slug:'mcp-project'})).json().project,other=(await api(owner,'POST','/projects',{name:'Other',slug:'other'})).json().project;
  const agent=async(scopes:string[])=>{const r=await api(owner,'POST',`/projects/${project.id}/agents`,{name:'MCP',scopes,hours:1});return r.json();};
  const read=await agent(['read']),write=await agent(['read','write']);
  const rpc=(token:string,method:string,params:any={},extra={})=>app.inject({method:'POST',url:'/mcp',payload:{jsonrpc:'2.0',id:1,method,params},headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream',...extra}});
  assert.equal((await app.inject({method:'POST',url:'/mcp',payload:{}})).statusCode,401);
  const init=await rpc(write.token,'initialize',{protocolVersion:'2025-11-25'});assert.equal(init.statusCode,200,init.body);assert.equal(init.json().result.protocolVersion,'2025-11-25');
  assert.equal((await app.inject({method:'GET',url:'/mcp',headers:{authorization:'Bearer '+read.token,origin:'https://evil.example'}})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:'/mcp',headers:{authorization:'Bearer '+read.token}})).statusCode,405);
  const tools=(await rpc(read.token,'tools/list')).json().result.tools;assert.equal(tools.some((t:any)=>t.name==='start_work'),false);assert.ok(tools.some((t:any)=>t.name==='project_context'));
  const call=(token:string,name:string,args:any={})=>rpc(token,'tools/call',{name,arguments:args});
  const denied=await call(read.token,'start_work',{project_id:project.id,note:'Read cannot write',idempotency_key:randomUUID()});assert.equal(denied.json().result.isError,true);
  const privateProject=await call(read.token,'project_context',{project_id:other.id});assert.equal(JSON.parse(privateProject.json().result.content[0].text).error.code,'NOT_FOUND');
  assert.equal((await call(write.token,'start_work',{project_id:project.id,note:'missing key'})).json().error.code,-32602);
  const args={project_id:project.id,note:'MCP work',idempotency_key:randomUUID()},started=await call(write.token,'start_work',args);assert.equal(started.json().result.isError,false,started.body);
  const work=JSON.parse(started.json().result.content[0].text).work;
  const replay=await call(write.token,'start_work',args);assert.equal(JSON.parse(replay.json().result.content[0].text).work.id,work.id);
  assert.equal((await call(write.token,'heartbeat',{session_id:work.id,generation:work.generation,idempotency_key:randomUUID()})).json().result.isError,false);
  await api(owner,'POST',`/agents/${write.id}/revoke`,{});assert.equal((await rpc(write.token,'tools/list')).statusCode,401);
 }finally{await app.close();await db.close();}
});
