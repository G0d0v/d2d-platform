#!/bin/bash
set -Eeuo pipefail
umask 077
mkdir -p /data/app /data/forgejo
export USER=node HOME=/data
config=/data/forgejo/app.ini
if [[ ! -f "$config" ]]; then
cat > "$config" <<'INI'
APP_NAME = D2D Git
RUN_USER = node
RUN_MODE = prod
WORK_PATH = /data/forgejo
[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = 3001
ROOT_URL = http://127.0.0.1:3001/
DISABLE_SSH = true
LFS_START_SERVER = false
[database]
DB_TYPE = sqlite3
PATH = /data/forgejo/forgejo.db
[repository]
ROOT = /data/forgejo/repositories
[security]
INSTALL_LOCK = true
[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
ENABLE_NOTIFY_MAIL = false
[mailer]
ENABLED = false
[actions]
ENABLED = false
[indexer]
REPO_INDEXER_ENABLED = false
[log]
MODE = console
LEVEL = warn
INI
fi
forgejo web --config "$config" --work-path /data/forgejo &
forgejo_pid=$!
app_pid=''
stop(){ trap - TERM INT; [[ -z "$app_pid" ]] || kill -TERM "$app_pid" 2>/dev/null || true; kill -TERM "$forgejo_pid" 2>/dev/null || true; wait || true; }
trap stop TERM INT EXIT
for n in $(seq 1 120); do
 if curl --fail --silent http://127.0.0.1:3001/user/login >/dev/null; then break; fi
 kill -0 "$forgejo_pid"; sleep 1
 [[ $n != 120 ]] || exit 1
done
if [[ ! -s /data/forgejo/api-token ]]; then
 password=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
 if ! forgejo admin user list --config "$config" --work-path /data/forgejo | grep -Eq '[[:space:]]d2d-service[[:space:]]'; then
 forgejo admin user create --config "$config" --work-path /data/forgejo --username d2d-service --password "$password" --email service@d2d.invalid --admin --must-change-password=false >/dev/null
 fi
 forgejo admin user generate-access-token --config "$config" --work-path /data/forgejo --username d2d-service --token-name "d2d-platform-$(date +%s)" --scopes all --raw > /data/forgejo/api-token.new
 mv /data/forgejo/api-token.new /data/forgejo/api-token
 unset password
fi
export FORGEJO_URL=http://127.0.0.1:3001 FORGEJO_OWNER=d2d-service
FORGEJO_TOKEN=$(cat /data/forgejo/api-token); export FORGEJO_TOKEN
node --import tsx server/index.ts &
app_pid=$!
wait -n "$app_pid" "$forgejo_pid"
exit 1
