#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Запустите команду от root'; exit 1; }
: "${D2D_URL:?}" "${D2D_HOST_ID:?}" "${D2D_HOST_TOKEN:?}"
[[ "$D2D_HOST_ID" =~ ^[a-f0-9-]{36}$ ]] || exit 2
case "$D2D_URL" in https://*|http://127.0.0.1:*) ;; *) echo 'Нужен HTTPS'; exit 2;; esac
command -v python3 >/dev/null || { apt-get update -qq; apt-get install -y python3; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
 apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
 if apt-cache show docker-compose-v2 >/dev/null 2>&1;then apt-get install -y docker-compose-v2;else apt-get install -y docker-compose;fi
 systemctl enable --now docker
fi
root="/etc/d2d-hosts/$D2D_HOST_ID"
mkdir -p "$root/docker"
export D2D_URL D2D_HOST_ID D2D_HOST_TOKEN
python3 - "$root/config.json" <<'PY'
import os,json,sys,uuid
p=sys.argv[1];old=json.load(open(p)) if os.path.exists(p) else {}
json.dump(dict(url=os.environ['D2D_URL'].rstrip('/'),id=os.environ['D2D_HOST_ID'],token=os.environ['D2D_HOST_TOKEN'],machine=old.get('machine',uuid.uuid4().hex)),open(p,'w'))
os.chmod(p,0o600)
PY
curl -fsS "${D2D_URL%/}/host-runner.py" -o "$root/runner.py"
chmod 700 "$root/runner.py"
cat >"/etc/systemd/system/d2d-host-$D2D_HOST_ID.service" <<EOF
[Unit]
Description=D2D project server connector
After=network-online.target docker.service
Wants=network-online.target
[Service]
Environment=HOME=$root
Environment=DOCKER_CONFIG=$root/docker
ExecStart=/usr/bin/python3 $root/runner.py $root/config.json
Restart=always
RestartSec=10
UMask=0077
NoNewPrivileges=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
unset D2D_HOST_TOKEN
systemctl daemon-reload
systemctl enable --now "d2d-host-$D2D_HOST_ID"
echo 'Сервер подключён. Состояние появится в разделе «Установка» D2D.'
