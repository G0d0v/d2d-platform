import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from './db.ts';
import {authenticate} from './auth.ts';
import {member,ownedWork,event} from './model.ts';
import {Problem} from './security.ts';
import type {Forgejo} from './forgejo.ts';
import type {GitHistory} from './git-history.ts';

export function registerGitGateway(app:FastifyInstance,db:Database,git?:Forgejo,history?:GitHistory){
  for(const type of ['application/x-git-upload-pack-request','application/x-git-receive-pack-request'])app.addContentTypeParser(type,async(_req:FastifyRequest,body:Readable)=>body);
  app.route<{Params:{id:string;'*':string}}>({method:['GET','POST'],url:'/git/:id.git/*',schema:{hide:true},handler:async(req,reply)=>{
    if(!git)throw new Problem(503,'GIT_NOT_CONFIGURED','Git ещё не настроен');
    const tail=req.params['*'],params=new URL(req.url,'http://local').searchParams,service=params.get('service');
    const info=req.method==='GET'&&tail==='info/refs'&&['git-upload-pack','git-receive-pack'].includes(service??'');
    const rpc=req.method==='POST'&&['git-upload-pack','git-receive-pack'].includes(tail);
    if(!info&&!rpc)throw new Problem(404,'NOT_FOUND','Git endpoint не найден');
    const write=(info?service:tail)==='git-receive-pack';
    const auth=req.headers.authorization;
    if(auth?.startsWith('Basic ')){
      const decoded=Buffer.from(auth.slice(6),'base64').toString('utf8'),colon=decoded.indexOf(':');
      req.headers.authorization=colon>=0?'Bearer '+decoded.slice(colon+1):undefined;
    }
    if(!req.headers.authorization){reply.header('WWW-Authenticate','Basic realm="D2D Git token"');throw new Problem(401,'UNAUTHENTICATED','Введите токен D2D как пароль Git');}
    // Keep revocation/handoff serialized with the entire receive-pack, including response.
    return db.transaction(async tx=>{
      if(write)await tx.query('SELECT id FROM control WHERE id=1 FOR UPDATE');
      const a=await authenticate(tx,req,write);await member(tx,a,req.params.id,write);
      const work=write?await ownedWork(tx,a,req.params.id,Number(req.headers['x-work-generation'])):null;
      if(!await git.exists(req.params.id))throw new Problem(404,'GIT_NOT_FOUND','Сначала включите Git в проекте');
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),3600000);
      reply.raw.once('close',()=>{if(!reply.raw.writableFinished)controller.abort();});
      try{
        const headers:Record<string,string>={Authorization:'Basic '+Buffer.from(git.options.owner+':'+git.options.token).toString('base64')};
        for(const name of ['content-type','content-encoding','git-protocol'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name] as string;
        let before:Set<string>|undefined;
        async function* trackedBody(){
          let prefix=Buffer.alloc(0),complete=false;
          for await(const chunk of req.body as Readable){
            if(complete){yield chunk;continue;}
            prefix=Buffer.concat([prefix,Buffer.from(chunk)]);
            let offset=0,commands=0;
            while(offset+4<=prefix.length){const hex=prefix.subarray(offset,offset+4).toString();if(!/^[a-f0-9]{4}$/i.test(hex))throw new Problem(422,'GIT_PROTOCOL','Неверный пакет Git');const length=parseInt(hex,16);if(length===0){complete=true;break;}if(length<4)throw new Problem(422,'GIT_PROTOCOL','Неверная длина пакета Git');if(offset+length>prefix.length)break;commands++;offset+=length;}
            if(!complete&&prefix.length>1024*1024)throw new Problem(422,'GIT_PROTOCOL','Слишком большой заголовок Git');
            if(complete){if(commands&&history)before=await history.snapshot(req.params.id);yield prefix;prefix=Buffer.alloc(0);}
          }
          if(!complete&&prefix.length)throw new Problem(422,'GIT_PROTOCOL','Неполный пакет Git');
        }
        const upstream=await fetch(`${git.options.url}/${git.repo(req.params.id)}.git/${tail}${info?'?service='+service:''}`,{method:req.method,headers,...(rpc?{body:write?trackedBody():req.body as any,duplex:'half' as any}:{}),signal:controller.signal,redirect:'error'});
        if(!upstream.ok||!upstream.body){await upstream.body?.cancel();throw new Problem(503,'GIT_UNAVAILABLE','Git не подтвердил операцию');}
        if(write&&rpc)await event(tx,a,req.params.id,'git.push','Принят Git push',{generation:Number(req.headers['x-work-generation'])});
        if(before&&history&&work)await history.recordPush(tx,req.params.id,a,work,before);
        reply.hijack();reply.raw.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??'application/octet-stream','Cache-Control':'no-store'});
        await pipeline(Readable.fromWeb(upstream.body as any),reply.raw);
      }catch(e){if(reply.raw.headersSent){reply.raw.destroy(e as Error);return;}if(e instanceof Problem)throw e;throw new Problem(503,'GIT_UNAVAILABLE','Git временно недоступен');}finally{clearTimeout(timer);}
    });
  }});
}
