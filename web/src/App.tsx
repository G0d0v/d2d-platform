import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Code2, Command, ExternalLink, FolderGit2, GitBranch, History, LayoutDashboard, ListTodo, LogOut, Menu, Moon, MoreHorizontal, Plus, Search, Settings, ShieldCheck, Sun, Users, Waypoints, X } from 'lucide-react';
import { api, ApiError, setCsrf, uploadZip } from './api.ts';
import { ActionForm, Avatar, date, Empty, ErrorBox, Field, Modal, Secret } from './components.tsx';
import { Auth } from './Auth.tsx';
import { ProjectTasks } from './ProjectTasks.tsx';
import { TaskPicker } from './TaskPicker.tsx';
import { ProjectSource } from './ProjectSource.tsx';
import { ProjectPeople } from './ProjectPeople.tsx';
import { AccountSecurity } from './AccountSecurity.tsx';
import { WorkspaceTeam } from './WorkspaceTeam.tsx';
import { ProjectHistory } from './ProjectHistory.tsx';
import { captureWork,requireWorkIntent,type WorkIntent } from './work-intent.ts';
import type { Project, ProjectDetail, Task, User, Work } from '../../server/contracts.ts';

const roles: Record<string, string> = { admin: 'Администратор', developer: 'Разработчик', viewer: 'Наблюдатель' };
const statuses: Record<string, string> = { todo: 'Запланировано', in_progress: 'В работе', review: 'На проверке', done: 'Готово' };
const workStates: Record<string, string> = { active: 'В разработке', paused: 'Пауза', review: 'На проверке' };
function navigate(path: string) { location.hash = path; }
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || 'projects');
  useEffect(() => { let previous=location.hash;const change = () => {
    if(document.querySelector('dialog[data-dirty="true"]')&&!window.confirm('В форме есть несохранённые изменения. Перейти и потерять черновик?')){history.replaceState(null,'',previous||location.pathname);return;}
    previous=location.hash;setRoute(location.hash.slice(1) || 'projects');
  }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  return route.split('/');
}
function Badge({ work }: { work: Work | null }) {
  return <span className={`badge ${work ? 'amber' : 'green'}`}><span className="status-dot"/>{work ? workStates[work.state] : 'Свободен'}</span>;
}
function ProjectMark({ name }: { name: string }) { return <span className="project-mark">{name.slice(0, 2).toUpperCase()}</span>; }

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined), [bootError, setBootError] = useState<Error | null>(null);
  const [projects, setProjects] = useState<Project[]>([]), [projectTotal, setProjectTotal] = useState(0), [projectPage, setProjectPage] = useState(1), [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [view, projectId, tab = 'overview'] = useRoute();
  const [error, setError] = useState<Error | null>(null), [loading, setLoading] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [modal, setModalState] = useState<string | null>(null), [secret, setSecret] = useState({ title: '', value: '', hint: '' });
  const [mobile, setMobile] = useState(false), [theme, setTheme] = useState(() => localStorage.getItem('d2d-theme') ?? 'dark');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  const sidebar = useRef<HTMLElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useState(''); const search = useRef<HTMLInputElement>(null);
  const [navigationProjects,setNavigationProjects]=useState<Project[]>([]);
  const [myWork,setMyWork]=useState<Project[]>([]),[attention,setAttention]=useState<any>({requests:[],projects:[]});
  const [workIntent,setWorkIntent]=useState<WorkIntent|null>(null),[requestAction,setRequestAction]=useState<{id:string;action:string}|null>(null);
  const importedProject=useRef<string|null>(null),formProject=useRef<string|null>(null),reloadSequence=useRef(0);
  const project = detail && detail.project.id === projectId ? detail.project : null;
  const work = project?.work ?? null, mine = work?.executor_id === user?.id, canWrite = !!project && project.member_role !== 'viewer' && !(project as any).archived_at;
  const canAdmin = project?.member_role === 'admin';
  function setModal(value:string|null){
    if(value && value!==modal){formProject.current=project?.id??null;if(['finish','manage','handoff','request','resolve'].includes(value)&&!(modal==='manage'&&value==='handoff'))setWorkIntent(captureWork(work));if(value==='import')importedProject.current=null;}
    setModalState(value);
  }
  const showSecret = (title: string, value: string, hint: string) => { setSecret({ title, value, hint }); setModal('secret'); };
  const flash = (message: string) => setToast(message);
  async function boot() {
    setBootError(null);
    try { const result = await api('/me'); setCsrf(result.csrf); setUser(result.user); }
    catch (err) { if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') setUser(null); else setBootError(err as Error); }
  }
  useEffect(() => { void boot(); }, []);
  useEffect(() => { const media = window.matchMedia('(max-width: 800px)'); const update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => {
    if (!mobile || !narrow) return;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setMobile(false); } };
    window.addEventListener('keydown', key);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', key); menuButton.current?.focus(); };
  }, [mobile, narrow]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'light' : 'dark' : theme; };
    apply(); localStorage.setItem('d2d-theme', theme); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.current?.focus(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const reload = useCallback(async () => {
    if (!user) return;
    try {
      const seq=++reloadSequence.current;
      const [result,own,notices,nextDetail,nav]=await Promise.all([api(`/projects?page=${projectPage}&q=${encodeURIComponent(query)}&state=${filter==='archived'?'all':filter}&archived=${filter==='archived'}`),api('/me/work'),api('/me/attention'),view==='project'&&projectId?api(`/projects/${projectId}`):Promise.resolve(null),api('/me/navigation')]);
      if(seq!==reloadSequence.current)return;
      setProjects(result.data);setProjectTotal(result.pagination.total);setMyWork(own.data);setAttention(notices);setDetail(nextDetail);setNavigationProjects(nav.data.map((p:Project)=>({...p,work:notices.projects.find((x:Project)=>x.id===p.id)?.work??null})));
      setError(null);
    } catch (err) {
      setError(err as Error);
      if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') setUser(null);
    }
  }, [user, view, projectId, projectPage,query,filter]);
  useEffect(()=>{setProjectPage(1);},[query,filter]);
  useEffect(() => { setLoading(true); void reload().finally(() => setLoading(false)); const timer = setInterval(() => void reload(), 30000); return () => clearInterval(timer); }, [reload]);
  useEffect(() => { setMobile(false); }, [view, projectId]);
  useEffect(()=>{if(formProject.current&&formProject.current!==projectId)setModalState(null);},[projectId]);
  useEffect(() => {
    if(!user)return;
    const timer=setInterval(()=>{void api('/me/work').then(async r=>{
      await Promise.all(r.data.map((p:Project)=>api(`/work-sessions/${p.work!.id}/heartbeat`,'POST',{generation:p.work!.generation}).catch(()=>undefined)));
    }).catch(()=>undefined);},60000);return()=>clearInterval(timer);
  },[user?.id]);
  async function done(message: string) { setModal(null); await reload(); flash(message); }
  async function workAction(action: string, body: Record<string, unknown>) {
    const intent=requireWorkIntent(workIntent,work); await api(`/work-sessions/${intent.id}/${action}`, 'POST', { generation: intent.generation, ...body }); await done('Рабочая сессия обновлена');
  }
  async function taskStatus(task: Task, status: string) {
    try { await api(`/tasks/${task.id}`, 'PATCH', { status, generation: work?.generation }, { 'If-Match': String(task.version) }); await reload(); flash('Статус задачи сохранён'); }
    catch (err) { setError(err as Error); }
  }
  const formText = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
  if (user === undefined) return <div className="boot"><Waypoints size={40}/><h2>D2D Platform</h2>{bootError ? <ErrorBox error={bootError} retry={boot}/> : <p className="muted">Открываем пространство…</p>}</div>;
  if (!user) return <Auth onLogin={result => { setUser(result.user); if (result.recovery_code) showSecret('Сохраните резервный код', result.recovery_code, 'Он нужен для восстановления доступа. Сохраните его в менеджере паролей: повторно код не отображается.'); }}/>;
  const filtered=projects;
  const working=myWork;
  const titles: Record<string, string> = { overview: 'Обзор', projects: 'Проекты', work: 'Моя работа', team: 'Команда', docs: 'Документация', settings: 'Настройки', integrations: 'Интеграции' };
  const navigation = [
    { id: 'overview', title: 'Обзор', icon: LayoutDashboard }, { id: 'projects', title: 'Проекты', icon: FolderGit2 },
    { id: 'work', title: 'Моя работа', icon: GitBranch }, { id: 'team', title: 'Команда', icon: Users },
    { id: 'integrations', title: 'Интеграции', icon: Waypoints }, { id: 'docs', title: 'Документация', icon: BookOpen },
  ];
  const projectRows = (list: Project[]) => <div className="project-list">{list.map(p => <a className="project-row" href={`#project/${p.id}/overview`} key={p.id}>
    <ProjectMark name={p.name}/><div className="project-name"><strong>{p.name}</strong><span>{p.description || p.slug}</span></div><Badge work={p.work}/>
    <div className="row-owner">{p.work ? <><Avatar small name={p.work.owner_name}/><span>{p.work.owner_name}</span></> : <span className="muted">Можно начать работу</span>}</div>
    <div className="row-meta"><ListTodo size={15}/>{p.open_tasks}<span className="sr-only">открытых задач</span></div><ChevronRight className="row-arrow" size={18}/>
  </a>)}</div>;
  return <div className="app-shell">
    {mobile && <button className="sidebar-backdrop" onClick={() => setMobile(false)} aria-label="Закрыть навигацию"/>}
    <aside ref={sidebar} id="sidebar" inert={narrow && !mobile} role={narrow && mobile ? 'dialog' : undefined} aria-modal={narrow && mobile ? true : undefined} aria-label="Навигация пространства" className={`sidebar ${mobile ? 'open' : ''}`} onKeyDown={e => {
      if (!narrow || !mobile || e.key !== 'Tab') return;
      const links = [...(sidebar.current?.querySelectorAll<HTMLElement>('a,button') ?? [])];
      if (e.shiftKey && document.activeElement === links[0]) { e.preventDefault(); links.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === links.at(-1)) { e.preventDefault(); links[0]?.focus(); }
    }}><button className="icon-button mobile-close" aria-label="Закрыть меню" onClick={() => setMobile(false)}><X size={20}/></button><a className="brand" href="#overview"><span className="brand-symbol"><Waypoints size={24}/></span><span>D2D<span className="brand-light"> Platform</span></span></a>
      <div className="workspace"><span className="workspace-symbol">{user.display_name[0].toUpperCase()}</span><div><strong>Рабочее пространство</strong><span>Команда разработчиков</span></div><ShieldCheck size={16}/></div>
      <span className="nav-caption">ПРОСТРАНСТВО</span><nav aria-label="Основная навигация">{navigation.map(n => <a key={n.id} href={`#${n.id}`} className={(view === n.id || n.id === 'projects' && view === 'project') ? 'active' : ''} aria-current={view === n.id ? 'page' : undefined}><n.icon size={19}/>{n.title}{n.id === 'work' && working.length > 0 && <span className="nav-count">{working.length}</span>}</a>)}</nav>
      <div className="sidebar-projects"><div className="nav-caption">ПРОЕКТЫ<button className="icon-button" aria-label="Создать проект" onClick={() => setModal('project')}><Plus size={15}/></button></div>
        {navigationProjects.slice(0, 5).map(p => <a href={`#project/${p.id}`} key={p.id} className="sidebar-project"><span className={`project-dot ${p.work ? 'busy' : ''}`}/><span>{p.name}</span>{p.work && <span className="tiny-label">в работе</span>}</a>)}
        {!projects.length && <span className="sidebar-hint">Здесь появятся ваши проекты</span>}</div>
      <div className="sidebar-bottom"><div className="local-status"><span className="status-dot"/>D2D <span>v0.2</span></div><a href="#settings" className="settings-link"><Settings size={18}/>Настройки</a>
        <div className="profile"><Avatar name={user.display_name}/><div><strong>{user.display_name}</strong><span>{user.role === 'owner' ? 'Владелец платформы' : 'Участник команды'}</span></div><button className="icon-button" aria-label="Выйти" title="Выйти" onClick={() => { void api('/auth/logout', 'POST', {}).then(() => { setUser(null); setProjects([]); setDetail(null); }).catch(setError); }}><LogOut size={17}/></button></div></div>
    </aside>
    <div className="main-shell" inert={narrow && mobile}><header className="topbar"><div className="breadcrumbs"><button ref={menuButton} className="icon-button mobile-menu" onClick={() => setMobile(!mobile)} aria-expanded={mobile} aria-controls="sidebar" aria-label="Открыть навигацию"><Menu size={22}/></button><span className="muted">Пространство</span><ChevronRight size={14}/><strong>{view === 'project' ? project?.name ?? 'Проект' : titles[view] ?? 'Проекты'}</strong></div>
      <div className="global-search"><Search size={16}/><input ref={search} value={query} onChange={e => { setQuery(e.target.value); if (view !== 'projects') navigate('projects'); }} aria-label="Поиск проектов" placeholder="Найти проект…"/><kbd>Ctrl K</kbd></div>
      <button className="icon-button" title="Сменить тему" aria-label="Сменить тему" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}</button><div className="topbar-divider"/><Avatar small name={user.display_name}/></header>
      <main id="main-content"><ErrorBox error={error} retry={() => void reload()}/>
      {(view === 'projects' || !titles[view] && view !== 'project') && <>
        <div className="page-heading"><div><div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>Проекты <span className="heading-count">{projectTotal}</span></h1><p>Загрузите исходники или создайте проект для совместной работы.</p></div><div className="heading-actions"><button className="button primary" onClick={()=>setModal('import')}><ArrowDownToLine size={18}/>Загрузить проект</button><button className="button" onClick={() => setModal('project')}><Plus size={18}/>Создать проект</button></div></div>
        <div className="workspace-summary"><div><FolderGit2 size={20}/><span>Все проекты<strong>{projectTotal}</strong></span></div><div><Activity size={20}/><span>В разработке на странице<strong>{attention.projects.length}</strong></span></div><div><ListTodo size={20}/><span>Открытых задач на странице<strong>{projects.reduce((n, p) => n + p.open_tasks, 0)}</strong></span></div><div className="summary-note"><ShieldCheck size={20}/><p>Один ответственный.<br/><strong>Вся команда в контексте.</strong></p></div></div>
        <div className="list-toolbar"><div className="filter-tabs" aria-label="Фильтр проектов">{[['all', 'Все проекты'], ['free', 'Свободные'], ['busy', 'В работе'], ['archived','Архив']].map(([id, title]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{title}</button>)}</div><span className="muted small-text">{filtered.length} на странице</span></div>
        {loading ? <div className="loading">Загружаем проекты…</div> : filtered.length ? <div className="list-panel"><div className="list-columns"><span>ПРОЕКТ</span><span>СОСТОЯНИЕ</span><span>ОТВЕТСТВЕННЫЙ</span><span>ЗАДАЧИ</span></div>{projectRows(filtered)}</div> : <div className="list-panel"><Empty icon={<FolderGit2 size={32}/>} title={projects.length ? 'Ничего не нашлось' : 'Первый проект — начало общей работы'} text={projects.length ? 'Измените запрос или выберите другой фильтр.' : 'Создайте проект, добавьте задачу и пригласите коллегу. Каждый будет знать, кто работает и что осталось сделать.'}>{!projects.length && <button className="button primary" onClick={() => setModal('project')}><Plus size={17}/>Создать первый проект</button>}</Empty></div>}
        {projectTotal > 50 && <div className="pagination"><button className="button" disabled={projectPage === 1} onClick={() => setProjectPage(n => n - 1)}>Назад</button><span>Страница {projectPage} из {Math.ceil(projectTotal / 50)}</span><button className="button" disabled={projectPage * 50 >= projectTotal} onClick={() => setProjectPage(n => n + 1)}>Далее</button></div>}
        <div className="bottom-note"><GitBranch size={16}/><span>Возьмите проект в разработку, чтобы команда видела вашу работу.</span><a href="#docs">Как это устроено<ArrowUpRight size={14}/></a></div>
      </>}
      {view === 'overview' && <><div className="page-heading"><div><span className="eyebrow">ОБЩИЙ КОНТЕКСТ</span><h1>Всё под рукой</h1><p>{user.display_name}, здесь видно, что происходит в ваших проектах.</p></div><button className="button primary" onClick={() => navigate('projects')}>К проектам<ArrowRight size={16}/></button></div>
        <Attention notices={attention} working={working}/><div className="section-heading"><h2>Сейчас в работе</h2><span className="muted">{attention.projects.length} на странице</span></div>{attention.projects.length > 0 ? projectRows(attention.projects) : <div className="list-panel"><Empty icon={<CheckCircle2 size={28}/>} title="Сейчас нет занятой работы" text="Откройте проект и начните следующую задачу."/></div>}
        <div className="onboarding-grid"><a href="#projects"><FolderGit2 size={24}/><h3>Начните с проекта</h3><p>Задачи, участники и история работы в одном месте.</p><ArrowUpRight size={18}/></a><a href="#work"><GitBranch size={24}/><h3>Сохраните контекст</h3><p>При передаче расскажите, что сделано и что осталось.</p><ArrowUpRight size={18}/></a><a href="#docs"><BookOpen size={24}/><h3>Подключите агента</h3><p>Ограниченные права и тот же рабочий процесс через API.</p><ArrowUpRight size={18}/></a></div></>}
      {view === 'work' && <><div className="page-heading"><div><span className="eyebrow">ЛИЧНЫЙ ФОКУС</span><h1>Моя работа</h1><p>Все ваши активные рабочие сессии независимо от страницы списка.</p></div></div>{working.length ? projectRows(working) : <div className="list-panel"><Empty icon={<GitBranch size={32}/>} title="Можно выбрать следующую задачу" text="Возьмите свободный проект в разработку. Здесь появится ваша рабочая сессия."><a className="button primary" href="#projects">Открыть проекты<ArrowRight size={16}/></a></Empty></div>}</>}
      {view === 'project' && <>{loading && !project ? <div className="loading">Открываем проект…</div> : project && detail ? <>
        <a href="#projects" className="back-link"><ArrowLeft size={15}/>Все проекты</a><div className="page-heading project-heading"><div className="project-title"><ProjectMark name={project.name}/><div><h1>{project.name}</h1><p>{project.description || 'Описание проекта ещё не добавлено'}</p></div></div><div className="heading-actions"><span className="role-label">{roles[project.member_role]}</span>{canAdmin&&<button className="button" onClick={()=>setModal('projectedit')}>Настройки проекта</button>}{!work && canWrite && <button className="button primary" onClick={() => setModal('start')}><GitBranch size={17}/>Взять в разработку</button>}</div></div>
        {work ? <div className="work-banner"><div className="work-banner-icon"><GitBranch size={23}/></div><div className="work-banner-content"><div><Badge work={work}/><strong>{work.owner_name}</strong>{work.executor_id !== work.owner_id && <span className="muted">· исполняет агент</span>}</div><p>{work.note}</p><div className="work-meta"><span><Clock3 size={13}/>до {date(work.expires_at)}</span><span className={Date.now() - Number(work.heartbeat_at) > 180000 ? 'warning-text' : ''}>{Date.now() - Number(work.heartbeat_at) > 180000 ? 'Связь потеряна' : 'Последняя связь'} · {date(work.heartbeat_at)}</span></div></div>
          <div className="work-banner-actions">{mine ? <><button className="button" onClick={() => setModal('finish')}><Check size={16}/>Завершить</button><button className="button" onClick={() => setModal('manage')}>Управление</button></> : canWrite && <button className="button" onClick={() => setModal('request')}>Запросить передачу<ArrowRight size={15}/></button>}{!mine && canAdmin && <button className="button" onClick={() => setModal('handoff')}>Передать с причиной</button>}</div>
        </div> : <div className="free-banner"><span className="status-dot"/><strong>Проект свободен</strong><span>Можно начать работу над следующей задачей.</span></div>}
        <div className="project-tabs">{[['overview', 'Обзор', LayoutDashboard], ['tasks', 'Задачи', ListTodo], ['team', 'Участники', Users], ['agents', 'ИИ-агенты', Bot], ['history', 'История работы', History], ['code', 'Исходники и установка', Code2]].map(([id, title, Icon]) => { const I = Icon as typeof Code2; return <a key={id as string} href={`#project/${project.id}/${id}`} className={tab === id ? 'active' : ''}><I size={16}/>{title as string}{id === 'tasks' && <span>{(detail as any).task_total??detail.tasks.length}</span>}</a>; })}</div>
        {tab === 'overview' && <div className="project-overview"><section><div className="section-heading"><h2>Следующие задачи</h2>{canWrite && <button className="text-button" onClick={() => setModal('task')}><Plus size={15}/>Добавить</button>}</div>{detail.tasks.filter(t => t.status !== 'done').length ? <div className="task-preview">{detail.tasks.filter(t => t.status !== 'done').slice(0, 6).map(t => <a key={t.id} href={`#project/${project.id}/tasks`}><Circle size={17}/><span>{t.title}</span><span className={`task-status ${t.status}`}>{statuses[t.status]}</span><ChevronRight size={16}/></a>)}</div> : <div className="inset-empty"><ListTodo size={24}/><p>Открытых задач пока нет.</p>{canWrite && <button className="button small" onClick={() => setModal('task')}>Добавить задачу</button>}</div>}
          <div className="section-heading spacing-top"><h2>Последние события</h2><a className="text-button" href={`#project/${project.id}/history`}>Вся история<ArrowRight size={14}/></a></div><Timeline events={detail.events.slice(0, 5)}/></section>
          <aside className="project-context"><div className="section-heading"><h2>Контекст проекта</h2><ShieldCheck size={17}/></div><dl><div><dt>Ваша роль</dt><dd>{roles[project.member_role]}</dd></div><div><dt>Участники</dt><dd>{detail.members.length}</dd></div><div><dt>Режим работы</dt><dd>Один исполнитель</dd></div><div><dt>Хранилище Git</dt><dd className="muted">Не подключено</dd></div></dl><p>При завершении или передаче сохраните заметку для следующего разработчика.</p>{(detail as any).last_handoff&&<div className="last-handoff"><h3>С чего продолжить</h3><blockquote>{(detail as any).last_handoff.summary}</blockquote><p className="muted">{(detail as any).last_handoff.author}</p></div>}
            {detail.handoffs.length > 0 && <div className="handoff-requests"><h3>Ожидают передачи</h3>{detail.handoffs.map(h => <div key={h.id}><strong>{h.requester_name}</strong><p>{h.note}</p><div className="request-actions">{h.requested_by===user.id?<button className="button small" onClick={()=>{setRequestAction({id:h.id,action:'cancel'});setModal('resolve');}}>Отменить запрос</button>:(mine||canAdmin)&&<><button className="button small" onClick={()=>{setRequestAction({id:h.id,action:'accept'});setModal('resolve');}}>Принять</button><button className="button small" onClick={()=>{setRequestAction({id:h.id,action:'reject'});setModal('resolve');}}>Отклонить</button></>}</div></div>)}{(mine || canAdmin) && <button className="button small" onClick={() => setModal('handoff')}>Передать проект</button>}</div>}
          </aside></div>}
        {tab === 'tasks' && <ProjectTasks key={project.id} projectId={project.id} work={work} userId={user.id} canWrite={canWrite} changed={()=>void reload()}/> }
        {tab === 'team' && <ProjectPeople key={project.id} projectId={project.id} members={detail.members} canAdmin={canAdmin} changed={()=>void reload()} add={()=>setModal('member')} invite={()=>setModal('invite')}/> }
        {tab === 'history' && <ProjectHistory key={project.id} projectId={project.id}/> }
        {tab === 'agents' && <><div className="section-heading"><div><h2>ИИ-агенты</h2><p className="muted small-text">Доступ к этому проекту. Git отключён. Право «Чтение и разработка» включает загрузку архивов и установку версии на сервер.</p></div>{canAdmin && <button className="button primary" onClick={() => setModal('agent')}><Plus size={16}/>Подключить агента</button>}</div>{canAdmin ? detail.agents.length ? <div className="list-panel">{detail.agents.map(a => <div className="agent-row" key={a.id}><span className="agent-icon"><Bot size={23}/></span><div><strong>{a.name}</strong><span className="muted">{a.scopes.includes('write') ? 'Чтение и разработка' : 'Только чтение'} · до {date(a.expires_at)}</span></div><span className={`badge ${a.revoked_at || Number(a.expires_at) <= Date.now() ? 'neutral' : 'green'}`}>{a.revoked_at ? 'Отозван' : Number(a.expires_at) <= Date.now() ? 'Истёк' : 'Действует'}</span>{!a.revoked_at && <button className="button small" onClick={() => { void api(`/agents/${a.id}/revoke`, 'POST', {}).then(() => { void reload(); flash('Доступ отозван'); }).catch(setError); }}>Отозвать</button>}</div>)}</div> : <div className="list-panel"><Empty icon={<Bot size={32}/>} title="Первый помощник для проекта" text="Выдайте агенту ограниченный токен. Он сможет читать задачи и работать с разрешённой сессией через API."/></div> : <div className="info-panel"><ShieldCheck size={22}/><p>Токенами агентов управляет администратор проекта.</p></div>}</>}
        {tab === 'code' && <ProjectSource key={project.id} projectId={project.id} work={work} canAdmin={!!canAdmin&&canWrite}/> }
      </> : !loading && !error && <Empty icon={<FolderGit2 size={30}/>} title="Проект недоступен" text="Проверьте ссылку и своё членство в проекте."/>}</>}
      {view === 'integrations' && <><div className="page-heading"><div><span className="eyebrow">СОСТОЯНИЕ ПЛАТФОРМЫ</span><h1>Интеграции</h1><p>Работающие возможности и границы локальной альфы.</p></div></div><IntegrationStatus/></>}
      {view === 'team' && <WorkspaceTeam invite={()=>setModal('invite')}/> }
      {view === 'docs' && <Docs/>}
      {view === 'settings' && <><div className="page-heading"><div><span className="eyebrow">ЛИЧНОЕ ПРОСТРАНСТВО</span><h1>Настройки</h1><p>Сделайте рабочее место удобным для себя.</p></div></div><section className="settings-panel"><h2>Внешний вид</h2><p className="muted">Выбор сохраняется в этом браузере.</p><div className="theme-options">{[['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в системе']].map(([value, title]) => <button key={value} aria-pressed={theme === value} className={`theme-option ${theme === value ? 'selected' : ''}`} onClick={() => setTheme(value)}><span className={`theme-preview ${value}`}><i/><i/><i/></span><span>{title}{theme === value && <Check size={16}/>}</span></button>)}</div><hr/><h2>Ваш аккаунт</h2><dl className="profile-details"><div><dt>Имя</dt><dd>{user.display_name}</dd></div><div><dt>Логин</dt><dd>@{user.login}</dd></div><div><dt>Восстановление</dt><dd>Резервный код</dd></div></dl><p className="muted small-text">Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Время отображается в настройках вашего браузера.</p></section><AccountSecurity/></>}
      </main><footer className="app-footer"><span>D2D Platform</span><span>Совместная разработка</span><a href="/api/docs" target="_blank" rel="noreferrer">API<ExternalLink size={12}/></a></footer></div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18}/>{toast}</div>}
    {modal && <Modal title={modal === 'secret' ? secret.title : ({ import:'Загрузить исходный проект',projectedit:'Настройки проекта',invite:'Пригласить коллегу',resolve:'Решение по передаче',project: 'Новый проект', task: 'Новая задача', start: 'Взять в разработку', finish: 'Завершить и освободить', handoff: 'Передать проект', request: 'Запросить передачу', member: 'Добавить участника', agent: 'Подключить ИИ-агента', manage: 'Управление работой' }[modal] ?? '')} close={() => setModal(null)}>
      {modal === 'secret' ? <><Secret value={secret.value} label={secret.hint}/><div className="dialog-actions"><button className="button primary" onClick={() => setModal(null)}>Я сохранил код<Check size={16}/></button></div></> : modal === 'manage' ? <div className="manage-actions"><p className="muted">Срок не продлевается от открытой вкладки. Максимум — 8 часов от начала сессии.</p><ErrorBox error={error}/><button className="button" onClick={() => void workAction('state', { state: work?.state === 'paused' ? 'active' : 'paused' }).catch(setError)}>{work?.state === 'paused' ? 'Возобновить' : 'Поставить на паузу'}</button><button className="button" onClick={() => void workAction('renew', { minutes: 120 }).catch(setError)}>Продлить до 2 часов от текущего времени</button><button className="button" onClick={() => setModal('handoff')}>Передать участнику<ArrowRight size={16}/></button></div> : <ActionForm close={() => setModal(null)} label={{ import:'Загрузить проект',projectedit:'Сохранить',invite:'Создать приглашение',resolve:'Подтвердить',project: 'Создать проект', task: 'Создать задачу', start: 'Начать работу', finish: 'Завершить работу', handoff: 'Передать проект', request: 'Отправить запрос', member: 'Добавить участника', agent: 'Создать токен' }[modal] ?? 'Сохранить'} submit={async data => {
        if(formProject.current&&project?.id!==formProject.current)throw new Error('Открыт другой проект. Закройте форму и повторите действие.');
        if(modal==='import') {
          const file=data.get('archive');if(!(file instanceof File)||!file.size)throw new Error('Выберите ZIP-архив');
          
          if(!importedProject.current){const r=await api('/projects','POST',{name:formText(data,'name'),slug:formText(data,'slug'),description:formText(data,'description')});importedProject.current=r.project.id;}
          const id=importedProject.current!;await uploadZip(id,file);await done('Исходный проект загружен');navigate(`project/${id}/code`);
        }
        if(modal==='projectedit'&&project){const archived=data.get('archived')==='on';if((project as any).archived_at&&!archived)await api(`/projects/${project.id}/restore`,'POST',{});if(!(project as any).archived_at||!archived)await api(`/projects/${project.id}`,'PATCH',{name:formText(data,'name'),description:formText(data,'description')});if(!(project as any).archived_at&&archived)await api(`/projects/${project.id}/archive`,'POST',{});await done('Настройки проекта сохранены');}
        if(modal==='invite'){const projectId=formText(data,'project_id');const r=await api('/invites','POST',{...(projectId?{project_id:projectId}:{}),role:formText(data,'role')});showSecret('Приглашение в команду',r.invite,`Одноразовый код действует до ${date(r.expires_at)}. После регистрации коллега получит выбранную роль в проекте.`);}
        if(modal==='resolve'&&requestAction){const intent=requireWorkIntent(workIntent,work);await api(`/transfer-requests/${requestAction.id}/resolve`,'POST',{action:requestAction.action,generation:intent.generation,summary:formText(data,'summary')});await done('Решение сохранено');}
        if (modal === 'project') { const r = await api('/projects', 'POST', { name: formText(data, 'name'), slug: formText(data, 'slug'), description: formText(data, 'description') }); await done('Проект создан'); navigate(`project/${r.project.id}`); }
        if (modal === 'task' && project) { await api(`/projects/${project.id}/tasks`, 'POST', { title: formText(data, 'title'), description: formText(data, 'description'), priority: formText(data, 'priority') }); await done('Задача создана'); }
        if (modal === 'start' && project) { const taskId = formText(data, 'task_id'); await api(`/projects/${project.id}/work-sessions`, 'POST', { note: formText(data, 'note'), minutes: Number(data.get('minutes')), ...(taskId ? { task_id: taskId } : {}) }); await done('Проект взят в разработку'); }
        if (modal === 'finish') await workAction('finish', { summary: formText(data, 'summary') });
        if (modal === 'handoff') await workAction('handoff', { summary: formText(data, 'summary'), to_user_id: formText(data, 'to_user_id') });
        if (modal === 'request' && work) { const intent=requireWorkIntent(workIntent,work); await api(`/work-sessions/${intent.id}/transfer-requests`, 'POST', { note: formText(data, 'note') }); await done('Запрос передачи отправлен'); }
        if (modal === 'member' && project) { await api(`/projects/${project.id}/members`, 'POST', { login: formText(data, 'login'), role: formText(data, 'role') }); await done('Участник добавлен'); }
        if (modal === 'agent' && project) { const r = await api(`/projects/${project.id}/agents`, 'POST', { name: formText(data, 'name'), scopes: formText(data, 'scope') === 'write' ? ['read', 'write'] : ['read'], hours: Number(data.get('hours')) }); await reload(); showSecret('Токен агента', r.token, 'Скопируйте в защищённое хранилище. Повторно токен не отображается. Доступ ограничен этим проектом.'); }
      }}>
        {(modal === 'project'||modal==='import') && <><Field label="Название проекта"><input name="name" required maxLength={100} placeholder="Например, панель управления" autoFocus/></Field><Field label="Идентификатор" hint="Латинские буквы, цифры и дефис. Минимум 2 символа."><input name="slug" required pattern="[a-z0-9][a-z0-9-]+" minLength={2} maxLength={60} placeholder="control-panel"/></Field><Field label="Описание"><textarea name="description" maxLength={2000} placeholder="Для чего нужен проект и что важно знать команде"/></Field>{modal==='import'&&<Field label="Исходный проект — ZIP" hint="Без .env, ключей, .git и node_modules. Корневая папка внутри архива поддерживается."><input name="archive" type="file" accept=".zip,application/zip" required/></Field>}</>}
        {modal==='projectedit'&&project&&<><Field label="Название"><input name="name" required maxLength={100} defaultValue={project.name}/></Field><Field label="Описание"><textarea name="description" maxLength={2000} rows={5} defaultValue={project.description}/></Field><label className="checkbox-field"><input name="archived" type="checkbox" defaultChecked={!!(project as any).archived_at}/>Проект в архиве (можно восстановить)</label><p className="muted">Архивирование завершает активную работу и отзывает токены агентов проекта.</p></>}
        {modal==='invite'&&<><Field label="Сразу добавить в проект"><select name="project_id" defaultValue={project?.id??navigationProjects.find(p=>p.member_role==='admin')?.id??''}><option value="">Только регистрация в пространстве</option>{navigationProjects.filter(p=>p.member_role==='admin').map(p=><option key={p.id} value={p.id}>{p.name}</option>)}{project&&!navigationProjects.some(p=>p.id===project.id)&&<option value={project.id}>{project.name}</option>}</select></Field><Field label="Роль после регистрации"><select name="role" defaultValue="developer">{Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></Field></>}
        {modal==='resolve'&&<Field label={requestAction?.action==='accept'?'Что сделано и с чего продолжить':'Комментарий к решению'}><textarea name="summary" required rows={5} maxLength={10000}/></Field>}
        {modal === 'task' && <><Field label="Что нужно сделать"><input name="title" required maxLength={200} autoFocus placeholder="Краткая цель задачи"/></Field><Field label="Описание и критерии готовности"><textarea name="description" maxLength={10000} rows={5}/></Field><Field label="Приоритет"><select name="priority" defaultValue="normal"><option value="normal">Обычный</option><option value="high">Высокий</option><option value="low">Низкий</option></select></Field></>}
        {modal === 'start' && <><p className="form-intro">Команда увидит вашу задачу и срок. После завершения сохраните краткий итог.</p><Field label="Над чем будете работать"><textarea name="note" required maxLength={2000} autoFocus placeholder="Цель и ожидаемый результат"/></Field>{project&&<TaskPicker projectId={project.id}/>}<Field label="Предполагаемое время"><select name="minutes" defaultValue="120"><option value="30">30 минут</option><option value="60">1 час</option><option value="120">2 часа</option></select></Field></>}
        {modal === 'finish' && <Field label="Что сделано, как проверено и что осталось"><textarea name="summary" required maxLength={10000} rows={6} autoFocus placeholder="Сохраните контекст для следующего разработчика"/></Field>}
        {modal === 'handoff' && <><Field label="Кому передать"><select name="to_user_id" required><option value="">Выберите участника</option>{detail?.members.filter(m => m.role !== 'viewer' && (m.id !== work?.owner_id || work?.executor_id !== work?.owner_id)).map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field><Field label="Заметка передачи и причина"><textarea name="summary" required rows={5} maxLength={10000} placeholder="Что готово, где остановились и с чего продолжить"/></Field></>}
        {modal === 'request' && <Field label="Зачем нужна передача"><textarea name="note" required maxLength={2000} autoFocus placeholder="Какую задачу хотите продолжить"/></Field>}
        {modal === 'member' && <><Field label="Логин зарегистрированного коллеги"><input name="login" required maxLength={32} autoFocus placeholder="colleague"/></Field><Field label="Роль в проекте"><select name="role" defaultValue="developer">{Object.entries(roles).map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select></Field></>}
        {modal === 'agent' && <><p className="form-intro">«Чтение и разработка» разрешает задачи, загрузку ZIP, настройку запуска и выдачу команды установки на сервер. Для записи агенту нужна действующая рабочая сессия. Управление участниками и токенами недоступно.</p><Field label="Название агента"><input name="name" required maxLength={100} autoFocus placeholder="Codex · разработка"/></Field><Field label="Права"><select name="scope"><option value="read">Только чтение</option><option value="write">Чтение и разработка</option></select></Field><Field label="Срок действия"><select name="hours" defaultValue="24"><option value="1">1 час</option><option value="24">1 день</option><option value="168">7 дней</option><option value="720">30 дней</option></select></Field></>}
      </ActionForm>}
    </Modal>}
  </div>;
}

function Timeline({ events, full = false }: { events: ProjectDetail['events']; full?: boolean }) {
  return <div className="timeline">{events.map(e => <div className="timeline-event" key={e.id}><span className="timeline-icon"><Activity size={14}/></span><div><p><strong>{e.actor_name}</strong> <span>{e.message}</span></p><time dateTime={new Date(Number(e.created_at)).toISOString()}>{date(e.created_at)}</time>{full && (e as any).detail?.summary && <blockquote>{(e as any).detail.summary}</blockquote>}</div></div>)}{events.length === 0 && <p className="muted">Событий пока нет.</p>}</div>;
}
function IntegrationStatus() {
  return <div className="integrations-panel"><div className="integration-row"><span className="integration-icon"><ShieldCheck size={25}/></span><div><h3>Координация команды</h3><p>Проекты, задачи, рабочие сессии, передача, аудит и токены агентов.</p></div><span className="badge green"><Check size={13}/>Работает</span></div>
    {[['Forgejo · Git и проверка кода', 'Требуется подключение и проверка контроля записи, отзыва прав и передачи во время push.'], ['Сборки и релизы', 'Включаются после интеграции Git и изолированного сборщика.'], ['Автоматические Git-релизы', 'Архивы и установка на сервер уже доступны в разделе проекта. Автоматическая сборка из Git ещё не подключена.']].map(([title, description]) => <div className="integration-row" key={title}><span className="integration-icon muted"><Code2 size={25}/></span><div><h3>{title}</h3><p>{description}</p></div><span className="badge neutral">Не подключено</span></div>)}<p className="integration-note">Загрузка исходников и установка архивной версии доступны в разделе «Исходники и установка» каждого проекта. Интеграция PSModule не выполнялась.</p></div>;
}
function Docs() {
  return <><div className="page-heading"><div><span className="eyebrow">ОБЩИЕ ПРАВИЛА</span><h1>Документация</h1><p>Первый рабочий сценарий для человека и ИИ-агента.</p></div><a href="/api/docs" target="_blank" rel="noreferrer" className="button">Справочник API<ExternalLink size={16}/></a></div>
    <div className="docs-layout"><article className="prose"><h2>Начните работу над проектом</h2><ol><li>Создайте проект и добавьте задачу с критериями готовности.</li><li>В разделе «Команда» создайте приглашение сразу в проект с выбранной ролью.</li><li>Нажмите «Взять в разработку», опишите цель и укажите срок.</li><li>Меняйте статусы задач в своей рабочей сессии. Остальные участники видят, кто занят.</li><li>Передайте проект коллеге с заметкой или завершите работу, сохранив итог.</li></ol><h2>Срок и потеря связи</h2><p>Рабочая сессия действует до двух часов. Открытая страница отправляет сигнал связи раз в минуту, но не продлевает владение. Через три минуты без сигнала появляется отметка потери связи. Проект остаётся занят до конца срока.</p><p>Продление доступно в управлении работой. Общий предел — восемь часов от начала. После истечения срока получите новую сессию: старое поколение больше не разрешает запись.</p>
      <h2>Подключите ИИ-агента</h2><ol><li>Откройте проект → «ИИ-агенты». Администратор может выдать токен чтения или разработки.</li><li>Сохраните токен в защищённое хранилище. Передавайте его в заголовке <code>Authorization: Bearer TOKEN</code>.</li><li>Проверьте <code>GET /api/v1/me</code> и получите <code>GET /api/v1/projects/PROJECT_ID/agent-context</code>.</li><li>Для мутаций передавайте стабильный <code>Idempotency-Key</code>. При потере ответа повторяйте тот же запрос с тем же ключом.</li><li>Получите рабочую сессию перед сменой статусов. Передавайте её <code>generation</code>, для задачи — <code>If-Match</code> с её версией.</li></ol><p><code>TOKEN</code> — ваш токен, <code>PROJECT_ID</code> — ID проекта из API. Агент ограничен одним проектом. Отзыв токена прекращает его новые операции и закрывает занятую им сессию.</p>
      <h2>Обработайте конфликт</h2><p><code>PROJECT_BUSY</code> означает, что проект занят. <code>STALE_LEASE</code> — поколение изменилось. <code>LEASE_EXPIRED</code> — срок завершён. Получите актуальный контекст перед следующим действием. При <code>VERSION_CONFLICT</code> перечитайте задачу.</p><h2>Восстановите доступ</h2><p>На странице входа выберите «Забыли пароль?», укажите логин, резервный код и новый пароль. Сохраните новый код. Старые браузерные сессии и токены ваших агентов будут отозваны.</p>
    </article><aside className="docs-aside"><BookOpen size={25}/><h3>Контракт API</h3><p>OpenAPI описывает маршруты установленной версии.</p><a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">Открыть OpenAPI<ArrowUpRight size={14}/></a><a href="/api/docs" target="_blank" rel="noreferrer">Справочник запросов<ArrowUpRight size={14}/></a><hr/><h3>Границы альфы</h3><p>Здесь координируется работа. Архивы и установка версии доступны в проекте. Git, PR и автоматические сборки ещё не подключены.</p></aside></div></>;
}

function Attention({notices,working}:{notices:any;working:Project[]}){const expiring=working.filter(p=>p.work&&Number(p.work.expires_at)-Date.now()<15*60000);return <section className="attention-panel"><h2>Требует внимания</h2>{!expiring.length&&!notices.requests.length?<p className="muted">Нет ожидающих запросов и сессий с истекающим сроком.</p>:<>{expiring.map(p=><a key={p.id} href={`#project/${p.id}`}><Clock3 size={17}/>Скоро истекает: {p.name} · до {date(p.work!.expires_at)}</a>)}{notices.requests.map((r:any)=><a key={r.id} href={`#project/${r.project_id}`}><Users size={17}/>{r.project_name}: запрос передачи от {r.requester_name}</a>)}</>}</section>;}
