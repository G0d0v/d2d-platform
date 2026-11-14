#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${D2D_URL:?Нужен адрес D2D}" "${D2D_INSTALL_ID:?Нужен ID установки}" "${D2D_INSTALL_TOKEN:?Нужен токен установки}"
[[ "$D2D_INSTALL_ID" =~ ^[a-f0-9-]{36}$ ]] || { echo 'Неверный ID установки'; exit 2; }
case "$D2D_URL" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) echo 'Требуется HTTPS адрес D2D'; exit 2;; esac
[[ "$EUID" == 0 ]] || { echo 'Запустите команду от root на целевом сервере'; exit 2; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  command -v apt-get >/dev/null || { echo 'Установите Docker Engine, Docker Compose v2 и Python 3'; exit 2; }
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 python3 curl
  systemctl enable --now docker
fi
command -v python3 >/dev/null || { echo 'Установите Python 3'; exit 2; }
HOST="$(hostname | tr -cd 'a-zA-Z0-9._-')"
TEMP="$(mktemp -d)"
BASE="${D2D_URL%/}/api/install/$D2D_INSTALL_ID"
auth=(-H "Authorization: Bearer $D2D_INSTALL_TOKEN")
claimed=0
report() {
  python3 -c 'import json,sys;print(json.dumps(dict(host=sys.argv[1],state=sys.argv[2],message=sys.argv[3])))' "$HOST" "$1" "$2" >"$TEMP/result.json"
  curl -fsS --retry 2 "${auth[@]}" -H 'Content-Type: application/json' --data-binary @"$TEMP/result.json" "$BASE/result" >/dev/null
}
cleanup() {
  result=$?
  if [[ "$result" != 0 && "$claimed" == 1 ]]; then
    if [[ -n "${OLD_RELEASE:-}" && -f "$OLD_RELEASE/compose.json" ]]; then
      docker compose -p "$COMPOSE_PROJECT" -f "$OLD_RELEASE/compose.json" up -d --wait --wait-timeout 120 || true
    fi
    report failed 'Установка не завершена. Проверьте вывод команды на сервере; предыдущая версия восстановлена, если была доступна.' || true
  fi
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
python3 -c 'import json,sys;print(json.dumps(dict(host=sys.argv[1])))' "$HOST" >"$TEMP/claim.json"
curl -fsS "${auth[@]}" -H 'Content-Type: application/json' --data-binary @"$TEMP/claim.json" "$BASE/claim" >"$TEMP/manifest.json"
claimed=1
mapfile -t meta < <(python3 - "$TEMP/manifest.json" <<'PY'
import json,sys,re,hashlib
m=json.load(open(sys.argv[1]));assert re.fullmatch('[a-f0-9-]{36}',m['project_id']);assert re.fullmatch('[a-f0-9-]{36}',m['artifact_id']);assert re.fullmatch('[a-f0-9]{64}',m['sha256'])
print(m['project_id']);print(m['artifact_id']);print(m['sha256'])
print(hashlib.sha256((m['sha256']+json.dumps(m['recipe'],sort_keys=True)).encode()).hexdigest())
PY
)
[[ "${#meta[@]}" == 4 ]] || { echo 'Неверный ответ D2D'; exit 2; }
PROJECT_ID="${meta[0]}"; ARTIFACT_ID="${meta[1]}"; SHA="${meta[2]}"
FINGERPRINT="${meta[3]}"
ROOT="/opt/d2d-projects/$PROJECT_ID"
mkdir -p "$ROOT/releases" "$ROOT/data"
exec 9>"$ROOT/install.lock"
flock -w 300 9 || { echo 'Другой процесс устанавливает этот проект'; exit 3; }
COMPOSE_PROJECT="d2d-${PROJECT_ID:0:8}"
OLD_RELEASE="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
RELEASE="$ROOT/releases/$ARTIFACT_ID-$D2D_INSTALL_ID"
if [[ -f "$ROOT/current-fingerprint" && "$(cat "$ROOT/current-fingerprint")" == "$FINGERPRINT" ]] && [[ -f "$OLD_RELEASE/compose.json" ]]; then
  docker compose -p "$COMPOSE_PROJECT" -f "$OLD_RELEASE/compose.json" up -d --wait --wait-timeout 180
  claimed=0
  report installed 'Эта версия уже установлена; состояние контейнеров проверено.'
  claimed=0; echo 'Эта версия уже установлена.'; exit 0
fi
curl -fsS --retry 2 "${auth[@]}" "$BASE/archive" -o "$TEMP/project.zip"
printf '%s  %s\n' "$SHA" "$TEMP/project.zip" | sha256sum -c -
mkdir -p "$RELEASE/source"
python3 - "$TEMP/project.zip" "$RELEASE/source" <<'PY'
import zipfile,sys,pathlib,stat
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
    if z.testzip(): raise RuntimeError('ZIP CRC mismatch')
    for e in z.infolist():
        p=(root/e.filename).resolve()
        if not p.is_relative_to(root) or stat.S_ISLNK(e.external_attr>>16): raise RuntimeError('Unsafe ZIP path')
    z.extractall(root)
PY
cp "$TEMP/manifest.json" "$RELEASE/manifest.json"
python3 - "$RELEASE" <<'PY'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1]);m=json.load(open(r/'manifest.json'));recipe=m['recipe'];source=r/'source'/recipe['root']
if recipe['type']=='compose':
    # Resolve relative Compose paths against the project's original directory.
    print('Docker Compose:',source/recipe['path'])
elif recipe['type'] in ('node','dockerfile'):
    build={'context':str(source)}
    if recipe['type']=='node':
        dockerfile=r/'Dockerfile.d2d'
        dockerfile.write_text('FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN if [ -f package-lock.json ]; then npm ci; else npm install; fi\nRUN npm run build --if-present\nENV NODE_ENV=production\nENV HOST=0.0.0.0\nCMD ["npm","start"]\n')
        build['dockerfile']=str(dockerfile)
    config={'services':{'app':{'build':build,'restart':'unless-stopped','ports':[f"127.0.0.1:{recipe['port']}:{recipe['port']}"],'environment':{'PORT':str(recipe['port']),'HOST':'0.0.0.0'}}}}
    envfile=r.parent.parent/'data'/'app.env'
    if envfile.exists():config['services']['app']['env_file']=[str(envfile)]
    (r/'compose.json').write_text(json.dumps(config))
else: raise RuntimeError('Настройте поддерживаемую инструкцию запуска в D2D')
PY
RECIPE_TYPE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["recipe"]["type"])' "$TEMP/manifest.json")"
if [[ "$RECIPE_TYPE" == compose ]]; then
  ORIGINAL="$(python3 - "$RELEASE" <<'PY'
import pathlib,json,sys
r=pathlib.Path(sys.argv[1]);m=json.load(open(r/'manifest.json'));print(r/'source'/m['recipe']['root']/m['recipe']['path'])
PY
)"
  # Compose resolves relative paths before converting to the stored deployment definition.
  compose_env=()
  if [[ -f "$ROOT/data/compose.env" ]]; then compose_env=(--env-file "$ROOT/data/compose.env"); fi
  docker compose "${compose_env[@]}" --project-directory "$(dirname "$ORIGINAL")" -p "$COMPOSE_PROJECT" -f "$ORIGINAL" config --format json >"$RELEASE/compose.json"
fi
docker compose -p "$COMPOSE_PROJECT" -f "$RELEASE/compose.json" config -q
python3 - "$RELEASE/compose.json" "$PROJECT_ID" "$FINGERPRINT" <<'PY'
import json,sys
p=sys.argv[1];c=json.load(open(p))
for name,service in c['services'].items():
    if 'build' in service: service['image']='d2d-'+sys.argv[2][:8]+'-'+name+':'+sys.argv[3][:24]
json.dump(c,open(p,'w'))
PY
docker compose -p "$COMPOSE_PROJECT" -f "$RELEASE/compose.json" build
docker compose -p "$COMPOSE_PROJECT" -f "$RELEASE/compose.json" pull --ignore-buildable
python3 - "$RELEASE/compose.json" <<'PY'
import json,sys,subprocess,pathlib
p=pathlib.Path(sys.argv[1]);c=json.load(open(p));(p.parent/'build-source.json').write_text(json.dumps(c))
for service in c['services'].values():
    if service.get('image'):
        service['image']=json.loads(subprocess.check_output(['docker','image','inspect',service['image']]))[0]['Id']
        service.pop('build',None)
p.write_text(json.dumps(c))
PY
docker compose -p "$COMPOSE_PROJECT" -f "$RELEASE/compose.json" up -d --no-build --wait --wait-timeout 180
ln -sfn "$RELEASE" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
printf '%s\n' "$SHA" >"$ROOT/current-sha256"
printf '%s\n' "$FINGERPRINT" >"$ROOT/current-fingerprint"
claimed=0
report installed 'Версия установлена; контейнеры запущены и проверки Docker Compose пройдены.'
echo "Установка завершена. Каталог: $ROOT/current"
echo "Статус: docker compose -p $COMPOSE_PROJECT -f $ROOT/current/compose.json ps"
echo 'Данные контейнеров и именованные Docker volumes при обновлении не удаляются.'
