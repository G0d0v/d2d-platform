import {Problem} from './security.ts';

export interface ForgejoOptions {url:string;token:string;owner:string;}
export class Forgejo {
  constructor(readonly options:ForgejoOptions){
    const url=new URL(options.url);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Forgejo должен слушать loopback');
    if(!/^[a-zA-Z0-9_-]+$/.test(options.owner))throw new Error('Некорректный владелец Forgejo');
  }
  repo(projectId:string){if(!/^[a-f0-9-]{36}$/.test(projectId))throw new Problem(404,'NOT_FOUND','Проект не найден');return `${this.options.owner}/project-${projectId}`;}
  async request(path:string,method='GET',body?:unknown):Promise<Response>{
    try{
      const r=await fetch(`${this.options.url.replace(/\/$/,'')}/api/v1${path}`,{method,headers:{Authorization:`token ${this.options.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000),redirect:'error'});
      if(!r.ok){await r.body?.cancel();throw new Problem(r.status===404?404:r.status===409?409:r.status===422?422:503,r.status===404?'GIT_NOT_FOUND':r.status===409?'GIT_CONFLICT':r.status===422?'GIT_VALIDATION':'GIT_UNAVAILABLE',r.status===404?'Репозиторий, ветка или файл не найдены':r.status===409?'Git-операция конфликтует с текущим состоянием':r.status===422?'Проверьте ветки, коммиты и параметры Git-операции':'Git временно недоступен. Повторите запрос позже');}
      return r;
    }catch(e){if(e instanceof Problem)throw e;throw new Problem(503,'GIT_UNAVAILABLE','Git временно недоступен. Повторите запрос позже');}
  }
  async json(path:string,method='GET',body?:unknown){const r=await this.request(path,method,body);const value=await r.text();if(!value)return {ok:true};try{return JSON.parse(value);}catch{throw new Problem(503,'GIT_UNAVAILABLE','Git вернул неожиданный ответ. Проверьте состояние операции');}}
  async exists(project:string){try{return await this.json(`/repos/${this.repo(project)}`);}catch(e){if(e instanceof Problem&&e.status===404)return null;throw e;}}
  async ensure(project:string){const old=await this.exists(project);if(old)return old;return this.json('/user/repos','POST',{name:`project-${project}`,private:true,auto_init:false,default_branch:'main',has_pull_requests:true,has_issues:false,has_wiki:false});}
}
