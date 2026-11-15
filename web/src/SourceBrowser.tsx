import {useEffect,useState} from 'react';
import {FileCode2,Folder,ArrowLeft,Download} from 'lucide-react';
import {ErrorBox} from './components.tsx';
type Source={id:string;files:{path:string;size:number}[];recipe:{root:string}};
export function SourceBrowser({artifact,projectId,canUpload=false}:{artifact:Source;projectId?:string;canUpload?:boolean}){
 const [directory,setDirectory]=useState(''),[query,setQuery]=useState(''),[selected,setSelected]=useState(''),[code,setCode]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState<Error|null>(null);
 const root=artifact.recipe.root;
 useEffect(()=>{setDirectory('');setSelected('');setCode('');setQuery('');setError(null);},[artifact.id]);
 useEffect(()=>{
  if(!selected)return;const controller=new AbortController();setLoading(true);setError(null);setCode('');
  void fetch(`/api/v1/artifacts/${artifact.id}/raw?path=${encodeURIComponent(selected)}`,{signal:controller.signal,credentials:'same-origin'}).then(async r=>{
   if(!r.ok){const data=await r.json();throw new Error(data.error?.message??'Не удалось загрузить файл');}
   const bytes=new Uint8Array(await r.arrayBuffer());if(controller.signal.aborted)return;
   setCode(bytes.slice(0,8192).includes(0)?'Двоичный файл. Откройте или скачайте исходный файл.':new TextDecoder().decode(bytes));
  }).catch(e=>{if(!controller.signal.aborted)setError(e);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[artifact.id,selected]);
 const entries=new Map<string,{path:string;name:string;folder:boolean;size:number}>();
 for(const f of artifact.files){
  const relative=f.path.slice(root.length);if(query){if(relative.toLowerCase().includes(query.toLowerCase()))entries.set(relative,{path:f.path,name:relative,folder:false,size:f.size});continue;}
  if(!relative.startsWith(directory))continue;const tail=relative.slice(directory.length),parts=tail.split('/'),folder=parts.length>1,name=parts[0];entries.set(name,{path:folder?directory+name+'/':f.path,name,folder,size:f.size});
 }
 const items=[...entries.values()].sort((a,b)=>Number(b.folder)-Number(a.folder)||a.name.localeCompare(b.name,'ru'));
 const raw=selected?`/api/v1/artifacts/${artifact.id}/raw?path=${encodeURIComponent(selected)}`:'';
 return <section className="source-browser"><div className="source-files-header"><strong>Файлы проекта · {artifact.files.length}</strong><input aria-label="Поиск файла" placeholder="Найти файл во всём проекте…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
 {canUpload&&projectId&&<a className="button source-upload-link" href={`#project/${projectId}/git/files?upload=1&path=${encodeURIComponent(directory.replace(/\/$/,''))}`}>Добавить файлы в эту папку · в текущую ветку</a>}<nav className="source-breadcrumbs" aria-label="Путь к каталогу"><button onClick={()=>{setDirectory('');setSelected('');}}>Проект</button>{directory.split('/').filter(Boolean).map((part,i,parts)=><span key={i}> / <button onClick={()=>{setDirectory(parts.slice(0,i+1).join('/')+'/');setSelected('');}}>{part}</button></span>)}</nav>
 <div className="source-file-list">{directory&&!query&&<button className="source-file" onClick={()=>{setDirectory(directory.split('/').slice(0,-2).join('/')+(directory.split('/').length>2?'/':''));setSelected('');}}><ArrowLeft size={16}/><span>На уровень выше</span></button>}{items.map(f=><button className={`source-file ${selected===f.path?'selected':''}`} key={f.path} onClick={()=>{if(f.folder){setDirectory(f.path);setSelected('');}else setSelected(f.path);}}>{f.folder?<Folder size={17}/>:<FileCode2 size={17}/>}<span>{f.name}</span><small>{f.folder?'Каталог':f.size>=1048576?`${(f.size/1048576).toFixed(1)} МиБ`:f.size>=1024?`${Math.ceil(f.size/1024)} КиБ`:`${f.size} Б`}</small></button>)}</div>
 <ErrorBox error={error}/>{selected&&<div className="source-code"><div className="source-code-heading"><strong>{selected.slice(root.length)}</strong><a href={raw} target="_blank" rel="noreferrer" className="button small"><Download size={15}/>Полный файл</a></div>{loading?<p className="muted panel-note">Загрузка файла…</p>:<pre className="code-lines">{code.split('\n').map((line,i)=><div className="code-line" key={i}><span className="line-number" aria-hidden="true">{i+1}</span><code>{line||' '}</code></div>)}</pre>}</div>}
 </section>;
}
