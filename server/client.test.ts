import {test} from 'node:test';import assert from 'node:assert/strict';import {api,ApiError} from '../web/src/api.ts';
test('при HTML 502 показывает понятную ошибку и сохраняет ключ для безопасного повтора',async()=>{
 const original=globalThis.fetch;const keys:string[]=[];
 globalThis.fetch=(async(_url:any,init:any)=>{keys.push(init.headers['Idempotency-Key']);return keys.length===1?new Response('<html>Bad Gateway</html>',{status:502,headers:{'content-type':'text/html'}}):new Response('{"ok":true}',{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
 try{await assert.rejects(api('/test-retry','POST',{note:'unchanged'}),e=>e instanceof ApiError&&e.code==='SERVER_UNAVAILABLE');assert.deepEqual(await api('/test-retry','POST',{note:'unchanged'}),{ok:true});assert.equal(keys[0],keys[1]);}finally{globalThis.fetch=original;}
});
