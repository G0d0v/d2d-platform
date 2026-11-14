#!/bin/bash
# D2D self-host, Debian/Ubuntu, Docker Compose v2. Never alters an existing native D2D.
set -Eeuo pipefail
umask 077
version="${D2D_VERSION:-v0.5.0}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || exit 1
repo=G0d0v/d2d-platform
root=/opt/d2d-community
local_port=''
domain=''
while (($#)); do
 case "$1" in --domain) domain="${2:?Укажите домен}";shift 2;; --local) local_port="${2:-19100}";shift 2;; *) echo "Неизвестный параметр: $1" >&2;exit 1;; esac
done
[[ $EUID == 0 ]] || { echo 'Запустите через sudo bash.' >&2;exit 1; }
if [[ -z "$local_port" && -z "$domain" ]]; then read -r -p 'Домен D2D (DNS A/AAAA должен указывать на этот сервер): ' domain </dev/tty; fi
if [[ -n "$local_port" ]]; then
 [[ "$local_port" =~ ^[0-9]+$ && "$local_port" -gt 1024 && "$local_port" -lt 65536 ]] || exit 1
 origin="http://127.0.0.1:$local_port"
else
 [[ "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$domain" == *.* && "$domain" != *..* ]] || { echo 'Неверный домен' >&2;exit 1; }
 origin="https://${domain,,}"
fi
if [[ -f "$root/runtime.env" ]]; then echo "D2D уже установлен в $root. Инструкция обновления: docs/SELF-HOSTING.md. Данные не изменены.";exit 1;fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
 command -v apt-get >/dev/null || { echo 'Установите Docker Engine и Compose v2, затем повторите команду.' >&2;exit 1; }
 apt-get update
 apt-get install -y ca-certificates curl docker.io python3
 if apt-cache show docker-compose-v2 >/dev/null 2>&1;then apt-get install -y docker-compose-v2;else apt-get install -y docker-compose;fi
fi
docker compose version >/dev/null
systemctl enable --now docker
command -v curl >/dev/null || apt-get install -y curl ca-certificates
mkdir -p "$root/releases"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
base="https://github.com/$repo/releases/download/$version"
curl -fL --retry 3 "$base/d2d-platform-$version.tar.gz" -o "$work/d2d-platform-$version.tar.gz"
curl -fL --retry 3 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
(cd "$work" && sha256sum --check SHA256SUMS)
release="$root/releases/$version"
[[ ! -e "$release" ]] || { echo 'Каталог релиза уже существует. Проверьте предыдущую попытку установки.' >&2;exit 1; }
mkdir "$release"
tar --extract --gzip --file "$work/d2d-platform-$version.tar.gz" --directory "$release" --no-same-owner
setup=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
dbpass=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
printf 'PUBLIC_ORIGIN=%s\nSETUP_TOKEN=%s\nREGISTRATION_MODE=invite\nPOSTGRES_USER=d2d\nPOSTGRES_DB=d2d\nPOSTGRES_PASSWORD=%s\nDATABASE_URL=postgresql://d2d:%s@db:5432/d2d\n' "$origin" "$setup" "$dbpass" "$dbpass" > "$root/runtime.env"
cat > "$root/compose.yaml" <<YAML
name: d2d-community
services:
  app:
    build: $release
    image: d2d-community:$version
    env_file: runtime.env
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - data:/data
    restart: unless-stopped
    stop_grace_period: 60s
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:19090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      start_period: 120s
      retries: 10
YAML
if [[ -n "$local_port" ]]; then
 printf '    ports:\n      - "127.0.0.1:%s:19090"\n' "$local_port" >> "$root/compose.yaml"
else
 cat >> "$root/compose.yaml" <<YAML
  proxy:
    image: caddy:2.10.2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
YAML
 cat > "$root/Caddyfile" <<CADDY
${domain,,} {
  reverse_proxy app:19090
}
CADDY
fi
cat >> "$root/compose.yaml" <<'YAML'
  db:
    image: postgres:18-alpine
    env_file: runtime.env
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U d2d -d d2d']
      interval: 5s
      timeout: 5s
      retries: 30
YAML
printf '\nvolumes:\n  data:\n  postgres_data:\n  caddy_data:\n  caddy_config:\n' >> "$root/compose.yaml"
chmod 600 "$root/runtime.env" "$root/compose.yaml"
if ! docker compose -f "$root/compose.yaml" up -d --build --wait --wait-timeout 300; then
 echo "Установка не завершена. Данные сохранены. Диагностика: cd $root && docker compose logs --tail 100" >&2;exit 1
fi
ln -s "$release" "$root/current"
printf '\nD2D готов: %s\nКод первоначальной настройки: %s\nСоздайте первый аккаунт, сохраните резервный код, пригласите команду.\nКонфигурация: %s/runtime.env (только root).\n' "$origin" "$setup" "$root"
