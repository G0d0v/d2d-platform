#!/usr/bin/env python3
"""D2D connector: outbound HTTPS, fixed project actions, durable operation receipts."""
import contextlib, fcntl, hashlib, json, os, pathlib, re, socket, stat, subprocess, sys, tempfile, time, urllib.request, zipfile

CONFIG=pathlib.Path(sys.argv[1]); cfg=json.loads(CONFIG.read_text())
assert re.fullmatch('[a-f0-9-]{36}',cfg['id'])
assert cfg['url'].startswith(('https://','http://127.0.0.1:'))
BASE=cfg['url']+'/api/hosts/'+cfg['id']
os.umask(0o077)
lock=open(CONFIG.parent/'runner.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect())

def request(path,body=None,extra=None):
    headers={'Authorization':'Bearer '+cfg['token'],'X-D2D-Machine':cfg['machine']}
    if extra:headers.update(extra)
    if body is not None:headers['Content-Type']='application/json'
    req=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    return opener.open(req,timeout=60)

def atomic(path,data):
    path=pathlib.Path(path);tmp=path.with_name(path.name+'.new')
    with tmp.open('w') as out:
        os.chmod(tmp,0o600);json.dump(data,out);out.flush();os.fsync(out.fileno())
    os.replace(tmp,path)
    directory=os.open(path.parent,os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)

def run(args,timeout=900,capture=False):
    result=subprocess.run(args,stdout=subprocess.PIPE if capture else subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=timeout)
    if result.returncode:
        stage=next((label for command,label in [('build','Сборка образа'),('pull','Получение образа'),('up','Запуск контейнеров'),('ps','Проверка состояния'),('config','Чтение Compose'),('inspect','Проверка образа')] if command in args),'Команда Docker')
        raise RuntimeError(stage+': ошибка '+str(result.returncode)+'. Проверьте конфигурацию, доступ к Docker и свободное место.')
    return result.stdout.decode(errors='replace') if capture else ''

def compose(project,file,*args,capture=False):
    return run(['docker','compose','-p','d2d-'+project[:8],*(['--env-file','/opt/d2d-projects/'+project+'/data/compose.env'] if pathlib.Path('/opt/d2d-projects/'+project+'/data/compose.env').exists() else []),'-f',str(file),*args],capture=capture)

def health(root,project):
    current=root/'current'
    if not (current/'compose.json').exists():return 'unknown','Приложение ещё не установлено',''
    try:
        output=compose(project,current/'compose.json','ps','--all','--format','json',capture=True)
        try:
            value=json.loads(output);rows=value if isinstance(value,list) else [value]
        except ValueError:rows=[json.loads(line) for line in output.splitlines() if line.strip()]
        healthy=bool(rows) and all(r.get('State')=='running' and r.get('Health','') in ('','healthy') for r in rows)
        # Only bounded container status is sent automatically; application logs can contain secrets.
        logs='\n'.join(str(r.get('Service',''))+': '+str(r.get('State',''))+' '+str(r.get('Health','')) for r in rows)[:16000]
        return ('healthy' if healthy else 'unhealthy'),'Состояние контейнеров проверено',logs
    except Exception:return 'unhealthy','Не удалось проверить контейнеры',''

def set_current(root,release):
    new=root/'current.new';new.unlink(missing_ok=True);new.symlink_to(release);os.replace(new,root/'current')

def execute(command,project):
    assert re.fullmatch('[a-f0-9-]{36}',project)
    artifact=command['artifact'];assert re.fullmatch('[a-f0-9-]{36}',artifact['id']);assert re.fullmatch('[a-f0-9]{64}',artifact['sha256'])
    root=pathlib.Path('/opt/d2d-projects')/project;root.mkdir(parents=True,exist_ok=True)
    with open(root/'install.lock','a') as mutex:
        fcntl.flock(mutex,fcntl.LOCK_EX)
        current=(root/'current').resolve() if (root/'current').exists() else None
        if command['action']=='restart':
            if not current:raise RuntimeError('Приложение не установлено')
            compose(project,current/'compose.json','restart')
            compose(project,current/'compose.json','up','-d','--no-build','--wait','--wait-timeout','180');return
        release=root/'releases'/('managed-'+command['id'])
        # If the acknowledgement was lost after switching current, never execute the update twice.
        if current==release and (release/'compose.json').exists():
            compose(project,release/'compose.json','up','-d','--no-build','--wait','--wait-timeout','180');return
        if command['action']=='rollback':
            candidates=[]
            for manifest in (root/'releases').glob('*/manifest.json'):
                with contextlib.suppress(Exception):
                    data=json.loads(manifest.read_text())
                    if data.get('artifact_id')==artifact['id'] and (manifest.parent/'compose.json').exists():candidates.append(manifest.parent)
            if not candidates:raise RuntimeError('Сохранённый образ предыдущей версии отсутствует')
            release=sorted(candidates,key=lambda p:p.stat().st_mtime)[-1]
        else:
            release.mkdir(parents=True,exist_ok=True);source=release/'source';source.mkdir(exist_ok=True)
            archive=release/'source.zip';hasher=hashlib.sha256()
            with request('/archive?command='+command['id'],extra={'X-D2D-Lease':command['lease']}) as response,archive.open('wb') as out:
                while True:
                    chunk=response.read(1024*1024)
                    if not chunk:break
                    hasher.update(chunk);out.write(chunk)
            if hasher.hexdigest()!=artifact['sha256']:raise RuntimeError('Контрольная сумма не совпадает')
            with zipfile.ZipFile(archive) as z:
                for entry in z.infolist():
                    target=(source/entry.filename).resolve()
                    if not target.is_relative_to(source.resolve()) or stat.S_ISLNK(entry.external_attr>>16):raise RuntimeError('Небезопасный путь ZIP')
                if z.testzip():raise RuntimeError('Повреждённый ZIP')
                z.extractall(source)
            recipe=artifact['recipe'];src=(source/recipe.get('root','')).resolve()
            if not src.is_relative_to(source.resolve()):raise RuntimeError('Неверный корень')
            if recipe['type']=='compose':
                original=(src/recipe['path']).resolve()
                if not original.is_relative_to(src):raise RuntimeError('Неверный Compose путь')
                config=json.loads(compose(project,original,'config','--format','json',capture=True))
            elif recipe['type'] in ('dockerfile','node'):
                build={'context':str(src)}
                if recipe['type']=='dockerfile':build['dockerfile']=recipe.get('path','Dockerfile')
                if recipe['type']=='node':
                    dockerfile=release/'Dockerfile.d2d';dockerfile.write_text('FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN if [ -f package-lock.json ]; then npm ci; else npm install; fi\nRUN npm run build --if-present\nENV NODE_ENV=production HOST=0.0.0.0\nCMD ["npm","start"]\n');build['dockerfile']=str(dockerfile)
                config={'services':{'app':{'build':build,'restart':'unless-stopped','ports':['127.0.0.1:'+str(recipe['port'])+':'+str(recipe['port'])],'environment':{'PORT':str(recipe['port']),'HOST':'0.0.0.0'}}}}
                env=root/'data'/'app.env'
                if env.exists():config['services']['app']['env_file']=[str(env)]
            else:raise RuntimeError('Нет инструкции запуска')
            for name,service in config['services'].items():
                if 'build' in service:service['image']='d2d-'+project[:8]+'-'+name+':'+artifact['sha256'][:24]
            definition=release/'compose.json';atomic(definition,config)
            compose(project,definition,'build');compose(project,definition,'pull','--ignore-buildable')
            atomic(release/'build-source.json',config)
            for service in config['services'].values():
                if service.get('image'):
                    service['image']=json.loads(run(['docker','image','inspect',service['image']],capture=True))[0]['Id'];service.pop('build',None)
            atomic(definition,config);atomic(release/'manifest.json',{'artifact_id':artifact['id'],'sha256':artifact['sha256'],'recipe':recipe})
        try:
            compose(project,release/'compose.json','up','-d','--no-build','--wait','--wait-timeout','180');set_current(root,release)
        except Exception:
            if current and (current/'compose.json').exists():compose(project,current/'compose.json','up','-d','--no-build','--wait','--wait-timeout','180')
            raise

while True:
    try:
        project=cfg.get('project');root=pathlib.Path('/opt/d2d-projects')/project if project else None
        state,message,logs=health(root,project) if root else ('unknown','Первое подключение','')
        installed={}
        if root:
            with contextlib.suppress(Exception):installed=json.loads((root/'current'/'manifest.json').read_text())
        with request('/poll',{'artifact_id':installed.get('artifact_id',''),'machine_id':cfg['machine'],'hostname':re.sub('[^a-zA-Z0-9._-]','',socket.gethostname())[:100] or 'server','state':state,'message':message,'logs':logs}) as response:data=json.load(response)
        cfg['project']=data['project_id'];atomic(CONFIG,cfg);command=data.get('command')
        if command:
            assert re.fullmatch('[a-f0-9-]{36}',command['id']);receipt=CONFIG.parent/(command['id']+'.receipt.json')
            if receipt.exists():result=json.loads(receipt.read_text())
            else:
                try:execute(command,cfg['project']);result={'state':'succeeded','message':'Операция выполнена, контейнеры проверены.'}
                except Exception as error:result={'state':'failed','message':str(error)[:900]}
                atomic(receipt,result)
            with request('/result',{'command_id':command['id'],'lease':command['lease'],**result}) as response:response.read()
    except Exception as error:
        # Do not print request objects, credentials, or subprocess output.
        print('D2D: связь или операция не подтверждена ('+type(error).__name__+'); повтор через 30 секунд.',flush=True)
    time.sleep(30)
