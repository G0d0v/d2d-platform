import type {FastifyInstance} from 'fastify';
import type {Database} from './db.ts';
import {authenticate} from './auth.ts';
import {Problem} from './security.ts';
import {object,text,integer} from './contracts.ts';

// Stateless Streamable HTTP. Each operation is reauthorized by the existing API.
export function registerMcp(app:FastifyInstance,db:Database,origin:string){
  const tools=[
    {name:'projects',description:'Проекты, доступные токену',properties:{},required:[],method:'GET',path:()=>'/projects'},
    {name:'project_context',description:'Контекст проекта, рабочая сессия и реальные права',properties:{project_id:text(80)},required:['project_id'],method:'GET',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/agent-context`},
    {name:'tasks',description:'Задачи проекта',properties:{project_id:text(80),page:integer(1,1000000)},required:['project_id'],method:'GET',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/tasks?page=${a.page??1}`},
    {name:'source_versions',description:'Архивные версии и результаты установки',properties:{project_id:text(80)},required:['project_id'],method:'GET',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/source`},
    {name:'git_status',description:'Git-репозиторий, адрес clone и ветки',properties:{project_id:text(80)},required:['project_id'],method:'GET',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/git`},
    {name:'start_work',description:'Взять проект в разработку. Сохраните generation и session id',properties:{project_id:text(80),note:text(2000),idempotency_key:text(150,8)},required:['project_id','note','idempotency_key'],method:'POST',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/work-sessions`,body:(a:any)=>({note:a.note})},
    {name:'heartbeat',description:'Подтвердить связь. Не продлевает срок',properties:{session_id:text(80),generation:integer(1,2147483647),idempotency_key:text(150,8)},required:['session_id','generation','idempotency_key'],method:'POST',path:(a:any)=>`/work-sessions/${encodeURIComponent(a.session_id)}/heartbeat`,body:(a:any)=>({generation:a.generation})},
    {name:'finish_work',description:'Завершить сессию с итогом. Выданные агентом команды установки перестанут работать',properties:{session_id:text(80),generation:integer(1,2147483647),summary:text(10000),idempotency_key:text(150,8)},required:['session_id','generation','summary','idempotency_key'],method:'POST',path:(a:any)=>`/work-sessions/${encodeURIComponent(a.session_id)}/finish`,body:(a:any)=>({generation:a.generation,summary:a.summary})},
    {name:'git_snapshot',description:'Подготовить архив точного Git-коммита для установки',properties:{project_id:text(80),ref:text(200),generation:integer(1,2147483647),idempotency_key:text(150,8)},required:['project_id','ref','generation','idempotency_key'],method:'POST',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/git/snapshot`,body:(a:any)=>({ref:a.ref})},
    {name:'agent_activity',description:'Шаги работы и запросы остановки агента',properties:{project_id:text(80)},required:['project_id'],method:'GET',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/agent-activity`},
    {name:'report_step',description:'Передать этап и проверить stop_requested. При остановке передайте state=stopped',properties:{project_id:text(80),generation:integer(1,2147483647),state:text(30),stage:text(120),message:text(4000,0),progress:integer(0,100),idempotency_key:text(150,8)},required:['project_id','generation','state','stage','message','idempotency_key'],method:'POST',path:(a:any)=>`/projects/${encodeURIComponent(a.project_id)}/agent-steps`,body:(a:any)=>({generation:a.generation,state:a.state,stage:a.stage,message:a.message,...(a.progress!==undefined?{progress:a.progress}:{})})},
    {name:'installation_command',description:'Выдать секретную команду установки конкретной архивной версии. Не публикуйте ответ. При потере ответа сначала проверьте source_versions, автоматический повтор запрещён',properties:{artifact_id:text(80),generation:integer(1,2147483647)},required:['artifact_id','generation'],method:'POST',path:(a:any)=>`/artifacts/${encodeURIComponent(a.artifact_id)}/installations`,body:()=>({})},
  ];

  app.route({method:['GET','DELETE','POST'],url:'/mcp',schema:{hide:true},handler:async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    if(req.headers.origin&&req.headers.origin!==origin)throw new Problem(403,'ORIGIN_REJECTED','Запрос с другого сайта запрещён');
    if(!req.headers.authorization?.startsWith('Bearer '))throw new Problem(401,'UNAUTHENTICATED','Для MCP нужен токен агента D2D');
    const actor=await db.transaction(tx=>authenticate(tx,req,false));if(!actor.agentId)throw new Problem(403,'AGENT_REQUIRED','MCP использует токен агента');
    if(req.method!=='POST')return reply.code(405).header('Allow','POST').send();
    const message=req.body as any;
    const error=(code:number,text:string)=>({jsonrpc:'2.0',id:message?.id??null,error:{code,message:text}});
    if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||('id' in message&&message.id!==null&&!['number','string'].includes(typeof message.id)))return reply.code(400).send(error(-32600,'Invalid Request'));
    if(req.headers.accept&&!req.headers.accept.includes('application/json')&&!req.headers.accept.includes('*/*'))return reply.code(406).send(error(-32600,'Accept must include application/json'));
    if(!('id' in message))return reply.code(202).send();
    const result=(value:any)=>({jsonrpc:'2.0',id:message.id,result:value});
    if(message.method==='initialize')return result({protocolVersion:['2025-11-25','2025-06-18','2025-03-26'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'d2d-platform',version:'0.5.0'},instructions:'Доступ ограничен проектом и правами токена. Для записи сначала получите рабочую сессию. Сохраняйте ключ намерения для безопасного повтора. Секретные команды установки не публикуйте.'});
    if(req.headers['mcp-protocol-version']&&!['2025-11-25','2025-06-18','2025-03-26'].includes(String(req.headers['mcp-protocol-version'])))return reply.code(400).send(error(-32600,'Unsupported protocol version'));
    if(message.method==='ping')return result({});
    if(message.method==='tools/list')return result({tools:tools.filter(t=>actor.scopes.includes('write')||t.method==='GET').map(t=>({name:t.name,description:t.description,inputSchema:object(t.properties,t.required),annotations:{readOnlyHint:t.method==='GET',destructiveHint:t.method!=='GET',idempotentHint:t.method==='GET'||t.name!=='installation_command',openWorldHint:false}}))});
    if(message.method!=='tools/call')return error(-32601,'Method not found');
    const tool=tools.find(t=>t.name===message.params?.name),args=message.params?.arguments??{};
    if(!tool)return error(-32602,'Unknown tool');
    const properties=tool.properties as Record<string,any>;
    if(!args||typeof args!=='object'||Array.isArray(args)||tool.required.some(key=>!Object.hasOwn(args,key))||Object.entries(args).some(([key,value])=>{
      if(!Object.hasOwn(properties,key))return true;const rule=properties[key];
      if(rule.type==='string')return typeof value!=='string'||value.length<(rule.minLength??0)||value.length>(rule.maxLength??Infinity)||(rule.pattern&&!new RegExp(rule.pattern).test(value));
      return !Number.isSafeInteger(value)||Number(value)<rule.minimum||Number(value)>rule.maximum;
    }))return error(-32602,'Invalid tool arguments');
    if(tool.method!=='GET'&&!actor.scopes.includes('write'))return result({content:[{type:'text',text:'Недостаточно прав: токен только для чтения'}],isError:true});
    const r=await app.inject({method:tool.method as any,url:'/api/v1'+tool.path(args),headers:{authorization:req.headers.authorization,...(args.idempotency_key?{'idempotency-key':args.idempotency_key}:{}),...(args.generation?{'x-work-generation':String(args.generation)}:{})},...('body' in tool?{payload:tool.body!(args)}:{})});
    return result({content:[{type:'text',text:r.body}],isError:r.statusCode>=400});
  }});
}
