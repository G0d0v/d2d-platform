import {useState,useRef} from 'react';
import {Upload,FolderUp,FileArchive} from 'lucide-react';
import {api,uploadGitFiles} from './api.ts';
import {ErrorBox,Field,Modal} from './components.tsx';
import {captureWork,requireWorkIntent} from './work-intent.ts';
import type {Work} from '../../server/contracts.ts';

export function UploadFiles({projectId,directory,refName,branches,empty,work,close,committed}:{projectId:string;directory:string;refName:string;branches:any[];empty:boolean;work:Work|null;close:()=>void;committed:(branch:string)=>Promise<void>}){
 const [files,setFiles]=useState<File[]>([]),[mode,setMode]=useState('files'),[strip,setStrip]=useState(true),[branch,setBranch]=useState(branches.some(b=>b.name===refName)?refName:work?.branch??'main'),[newBranch,setNewBranch]=useState(!empty&&!branches.some(b=>b.name===refName)),[from,setFrom]=useState(refName),[path,setPath]=useState(directory),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<Error|null>(null);
 const intent=useRef(captureWork(work)),heads=useRef(Object.fromEntries(branches.map(b=>[b.name,b.commit.id??b.commit.sha]))),input=useRef<HTMLInputElement>(null),folder=useRef<HTMLInputElement>(null),zip=useRef<HTMLInputElement>(null);
 const paths=files.map(file=>({file,path:mode==='folder'?(strip?file.webkitRelativePath.split('/').slice(1).join('/'):file.webkitRelativePath):file.name}));
 function choose(type:string){setMode(type);setFiles([]);setStrip(type==='zip');const picker=({files:input,folder,zip}[type])?.current;if(picker){picker.value='';picker.click();}}
 return <Modal title="Загрузить в репозиторий" close={busy?()=>{}:close}><form onSubmit={async e=>{e.preventDefault();setError(null);setBusy(true);try{
  const captured=requireWorkIntent(intent.current,work);if(!files.length)throw new Error('Выберите файлы, папку или ZIP');
  const source=newBranch?from:branch;
  // Capture the chosen head before sending bytes; the server compares it again at commit time.
  const head=empty?'':heads.current[source]??(newBranch?(await api(`/projects/${projectId}/git/commits?ref=${encodeURIComponent(source)}`)).commits[0]?.sha:undefined);
  if(!empty&&!head)throw new Error('Не удалось определить коммит выбранной версии');
  const result=await uploadGitFiles(projectId,paths,{branch,from:head??'',expected_head:head??'',new_branch:String(newBranch),path,message,strip_root:String(strip)},captured.generation,mode==='zip'?files[0]:undefined);
  await committed(result.branch);close();
 }catch(e){setError(e as Error);}finally{setBusy(false);}}}>
 <p className="muted">Открытая папка: <code>{directory||'корень проекта'}</code>. Файлы с совпадающими путями будут заменены, остальные сохранятся. Загрузка создаст один коммит с вашим описанием.</p>
 <div className="heading-actions"><button className="button" type="button" disabled={busy} onClick={()=>choose('files')}><Upload size={16}/>Файлы</button><button className="button" type="button" disabled={busy} onClick={()=>choose('folder')}><FolderUp size={16}/>Папка</button><button className="button" type="button" disabled={busy} onClick={()=>choose('zip')}><FileArchive size={16}/>ZIP</button></div>
 <input className="sr-only" ref={input} type="file" multiple aria-label="Выбрать файлы" onChange={e=>setFiles(Array.from(e.target.files??[]))}/>
 <input className="sr-only" ref={folder} type="file" multiple {...{webkitdirectory:'',directory:''}} aria-label="Выбрать папку" onChange={e=>setFiles(Array.from(e.target.files??[]))}/>
 <input className="sr-only" ref={zip} type="file" accept=".zip,application/zip" aria-label="Выбрать ZIP" onChange={e=>setFiles(Array.from(e.target.files??[]))}/>
 <p role="status">{files.length?`${mode==='zip'?'Архивов':'Файлов'}: ${files.length}`:'Пока ничего не выбрано'}</p>
 {mode!=='files'&&<label className="checkbox-field"><input type="checkbox" checked={strip} disabled={busy} onChange={e=>setStrip(e.target.checked)}/>{mode==='zip'?'Убрать общую корневую папку архива':'Загрузить содержимое папки без её имени'}</label>}
 <Field label="Папка назначения" hint="Относительно корня репозитория. Пусто — корень."><input value={path} onChange={e=>setPath(e.target.value)} disabled={busy} maxLength={1000} placeholder="src/components"/></Field>
 {mode!=='zip'&&files.length>0&&<pre className="upload-preview">{paths.slice(0,30).map(f=>(path?path+'/':'')+f.path).join('\n')}{paths.length>30?`\n…ещё ${paths.length-30} файлов`:''}</pre>}
 <label className="checkbox-field"><input type="checkbox" checked={newBranch} disabled={busy} onChange={e=>{setNewBranch(e.target.checked);setBranch(e.target.checked?'':branches.some(b=>b.name===refName)?refName:branches[0]?.name??'main');}}/>Создать отдельную ветку</label>
 {newBranch?<><Field label="Новая ветка"><input value={branch} onChange={e=>setBranch(e.target.value)} required maxLength={200} disabled={busy}/></Field>{!empty&&<Field label="Создать от ветки, тега или коммита"><input value={from} onChange={e=>setFrom(e.target.value)} required maxLength={200} disabled={busy}/></Field>}</>:<Field label="Ветка"><select value={branch} onChange={e=>setBranch(e.target.value)} disabled={busy}>{empty?<option value={branch}>{branch}</option>:branches.map(b=><option key={b.name} value={b.name}>{b.name}</option>)}</select></Field>}
 <Field label="Описание изменений" hint="Будет сохранено в Git и истории разработки."><textarea value={message} onChange={e=>setMessage(e.target.value)} required maxLength={500} rows={3} disabled={busy} placeholder="Например: исправлена авторизация и добавлен экран настроек"/></Field>
 <p className="muted small-text">Не включайте .env, приватные ключи, .git и node_modules. Пустые папки Git не хранит. При изменении рабочей сессии или ветки загрузка остановится.</p>
 <ErrorBox error={error}/><div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={close}>Отмена</button><button className="button primary" disabled={busy||!files.length}>{busy?'Загружаем и создаём коммит…':'Загрузить и сохранить коммит'}</button></div>
 </form></Modal>;
}
