#!/usr/bin/env bash
# Update an existing D2D installation. Preserve configuration and back up data before switching.
set -Eeuo pipefail
umask 077
version="${D2D_VERSION:-v0.6.1}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || exit 2
[[ "$EUID" == 0 ]] || { echo 'Запустите через sudo bash'; exit 2; }
if [[ -f /opt/d2d-community/runtime.env ]]; then
  root=/opt/d2d-community; mode=docker
elif [[ -f /etc/d2d.env && -L /opt/d2d/current ]]; then
  root=/opt/d2d; mode=native
else
  echo 'D2D не найден. Для первой установки используйте install.sh.' >&2; exit 2
fi
exec 9>"$root/update.lock"
flock -w 10 9 || { echo 'Обновление D2D уже выполняется'; exit 3; }
current="$(readlink -f "$root/current" 2>/dev/null || true)"
if [[ -f "$current/package.json" ]] && python3 - "$current/package.json" "${version#v}" <<'PY'
import json,sys
raise SystemExit(0 if json.load(open(sys.argv[1]))['version']==sys.argv[2] else 1)
PY
then echo "Уже установлена версия $version. Данные не изменены."; exit 0; fi
work=$(mktemp -d)
switched=0; stopped=0
cleanup() {
  result=$?
  if [[ "$result" != 0 ]]; then
    if [[ "$mode" == native && "$stopped" == 1 ]]; then
      systemctl stop d2d || true
      if [[ "$switched" == 1 ]]; then ln -sfn "$current" "$root/current.rollback"; mv -Tf "$root/current.rollback" "$root/current"; fi
      systemctl start d2d || true
    elif [[ "$mode" == docker && "$stopped" == 1 ]]; then
      if [[ "$switched" == 1 ]]; then cp "$work/compose.previous" "$root/compose.yaml"; fi
      docker compose -f "$root/compose.yaml" up -d --wait --wait-timeout 300 || true
    fi
    echo 'Обновление не завершено. Проверьте вывод и резервную копию. Схема БД автоматически назад не откатывается.' >&2
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
base="https://github.com/G0d0v/d2d-platform/releases/download/$version"
release="$root/releases/$version-$(date -u +%Y%m%d%H%M%S)-$$"
mkdir -p "$release"
incremental=0
if [[ -f "$current/package.json" ]]; then
 old_version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$current/package.json")
 if [[ "$old_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  delta_name="d2d-platform-v$old_version-to-$version.zip"
  if curl -fsSL --retry 2 "$base/$delta_name" -o "$work/$delta_name"; then
   curl -fsSL --retry 3 "$base/FILES-SHA256SUMS" -o "$work/FILES-SHA256SUMS"
   curl -fsSL --retry 3 "$base/apply-project-update.py" -o "$work/apply-project-update.py"
   awk -v file="$delta_name" '$2==file || $2=="apply-project-update.py" {print}' "$work/FILES-SHA256SUMS" >"$work/selected-SHA256SUMS"
   [[ $(wc -l <"$work/selected-SHA256SUMS") == 2 ]] || { echo 'Не найдены контрольные суммы пакета обновления'; exit 2; }
   (cd "$work" && sha256sum --check selected-SHA256SUMS)
   tar -C "$current" --exclude='./node_modules' --exclude='./dist' --exclude='./.d2d' --exclude='./.git' -cf - . | tar -C "$release" -xf -
   python3 "$work/apply-project-update.py" "$work/$delta_name" "$release"
   python3 - "$work/$delta_name" >"$release/REVISION" <<'PY'
import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as package:print(json.loads(package.read('d2d-update.json'))['head_sha'])
PY
   incremental=1
   echo "Исходники D2D: скачаны только изменённые файлы v$old_version → $version."
  fi
 fi
fi
if [[ "$incremental" == 0 ]]; then
curl -fL --retry 3 "$base/d2d-platform-$version.tar.gz" -o "$work/d2d-platform-$version.tar.gz"
curl -fL --retry 3 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
(cd "$work" && sha256sum --check SHA256SUMS)
python3 - "$work/d2d-platform-$version.tar.gz" "$release" <<'PY'
import tarfile,sys
with tarfile.open(sys.argv[1]) as tar: tar.extractall(sys.argv[2], filter='data')
PY
fi
python3 - "$release/package.json" "${version#v}" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['version']==sys.argv[2], 'Версия дистрибутива не совпала'
PY
stamp=$(date -u +%Y%m%d-%H%M%S)
if [[ "$mode" == native ]]; then
  cd "$release"
  npm ci --no-audit
  npm run build
  chown -R d2d:d2d "$release"
  systemctl stop d2d; stopped=1
  bash "$current/deploy/backup.sh"
  ln -sfn "$release" "$root/current.new"; mv -Tf "$root/current.new" "$root/current"; switched=1
  systemctl start d2d
  healthy=0
  for ((i=0;i<60;i++)); do if curl -fsS http://127.0.0.1:19090/health >/dev/null; then healthy=1; break; fi; sleep 2; done
  [[ "$healthy" == 1 ]] || exit 1
else
  cd "$root"
  cp compose.yaml "$work/compose.previous"
  docker compose -f compose.yaml config --format json >"$work/stack.json"
  python3 - "$work/stack.json" "$release" "$version" >"$root/compose.next.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]));app=c['services']['app']
app['build']={'context':sys.argv[2]};app['image']='d2d-community:'+sys.argv[3]
json.dump(c,sys.stdout)
PY
  docker compose -f compose.next.json build app
  docker pull busybox:1.37 >/dev/null
  mkdir -p backups; chmod 700 backups
  docker compose -f compose.yaml stop app; stopped=1
  docker compose -f compose.yaml exec -T db pg_dump -U d2d -d d2d -Fc >"backups/db-$stamp.dump"
  volume=$(python3 - "$work/stack.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]));mount=next(v for v in c['services']['app']['volumes'] if v['target']=='/data')
assert mount['type']=='volume', 'Для нестандартного bind mount сделайте ручную резервную копию'
print(c['volumes'][mount['source']]['name'])
PY
)
  docker run --rm -v "$volume:/data:ro" -v "$root/backups:/backup" busybox:1.37 tar -czf "/backup/data-$stamp.tar.gz" -C /data .
  tar -czf "backups/config-$stamp.tar.gz" runtime.env compose.yaml
  [[ ! -f Caddyfile ]] || cp Caddyfile "backups/Caddyfile-$stamp"
  chmod 600 backups/*
  mv -f compose.next.json compose.yaml; switched=1
  docker compose -f compose.yaml up -d --wait --wait-timeout 300
  ln -sfn "$release" "$root/current.new"; mv -Tf "$root/current.new" "$root/current"
fi
stopped=0
echo "D2D обновлён до $version. Настройки, аккаунты и проекты сохранены. Резервная копия создана до переключения."
