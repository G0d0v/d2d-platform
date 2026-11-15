export class ApiError extends Error {
  constructor(message: string, public code = 'NETWORK_ERROR', public requestId?: string) { super(message); }
}
let csrf = '';
const pending = new Map<string, string>();
export const setCsrf = (value: string) => { csrf = value; };
async function responseJson(response:Response){
  try{return await response.json();}catch{throw new ApiError(response.status>=500?'Сервер временно недоступен или обновляется. Обновите данные через несколько секунд.':'Сервер вернул неожиданный ответ. Обновите данные перед повтором действия.',response.status>=500?'SERVER_UNAVAILABLE':'UNEXPECTED_RESPONSE');}
}
export async function uploadZip(projectId:string,file:File,generation?:number){
  let response:Response;try{response=await fetch(`/api/v1/projects/${projectId}/source`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/zip','X-CSRF-Token':csrf,'X-Filename':encodeURIComponent(file.name),...(generation?{'X-Work-Generation':String(generation)}:{})},body:file});}catch{throw new ApiError('Не получено подтверждение загрузки. Обновите список версий перед повтором.');}
  const data=await responseJson(response);if(!response.ok)throw new ApiError(data.error?.message??'Не удалось загрузить проект',data.error?.code,data.error?.request_id);return data;
}
export async function uploadGitFiles(projectId:string,files:{file:File;path:string}[],options:Record<string,string>,generation:number,zip?:File,onProgress?:(percent:number)=>void){
 const manifest=new TextEncoder().encode(JSON.stringify({files:files.map(f=>({path:f.path,size:f.file.size}))}));
 const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,manifest.byteLength);
 const body=zip??new Blob([length,manifest,...files.map(f=>f.file)]);
 let response:Response;try{
  const url=`/api/v1/projects/${projectId}/git/upload?${new URLSearchParams(options)}`;
  const headers={'Content-Type':zip?'application/zip':'application/vnd.d2d.files-v1','X-CSRF-Token':csrf,'X-Work-Generation':String(generation)};
  response=onProgress?await new Promise<Response>((resolve,reject)=>{
   const xhr=new XMLHttpRequest();xhr.open('POST',url);xhr.withCredentials=true;
   for(const [key,value] of Object.entries(headers))xhr.setRequestHeader(key,value);
   xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.floor(event.loaded/event.total*100));};
   xhr.onload=()=>resolve(new Response(xhr.responseText,{status:xhr.status}));
   xhr.onerror=()=>reject(new Error('network'));xhr.onabort=()=>reject(new Error('aborted'));
   xhr.send(body);
  }):await fetch(url,{method:'POST',credentials:'same-origin',headers,body});
 }catch{throw new ApiError('Нет подтверждения загрузки. Обновите историю ветки перед повтором: коммит мог сохраниться.');}
 const data=await responseJson(response);if(!response.ok)throw new ApiError(data.error?.message??'Загрузка не выполнена',data.error?.code,data.error?.request_id);return data;
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const intent = JSON.stringify({ path, method, body, extra });
  const mutation = method !== 'GET';
  if (mutation && !pending.has(intent)) pending.set(intent, crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(mutation ? { 'X-CSRF-Token': csrf, 'Idempotency-Key': pending.get(intent)! } : {}), ...extra,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(/\/git\/(import|snapshot)$/.test(path)?3600000:20000) });
  } catch { throw new ApiError('Нет связи с сервером. Проверьте подключение и обновите данные.'); }
  const data = await responseJson(response);
  // A lost response keeps the intent key so a manual retry is safe within this page.
  if (response.status < 500) pending.delete(intent);
  if (!response.ok) throw new ApiError(data.error?.message ?? 'Не удалось выполнить действие', data.error?.code, data.error?.request_id);
  return data as T;
}
