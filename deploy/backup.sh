#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
DEST=/var/backups/d2d
mkdir -p "$DEST"
NAME="$DEST/d2d-$(date -u +%Y%m%d-%H%M%S)"
runuser -u postgres -- pg_dump -Fc d2d >"$NAME.pg.dump"
tar -czf "$NAME.files.tar.gz" -C / var/lib/d2d etc/d2d.env etc/nginx/sites-available/d2d etc/systemd/system/d2d.service
find "$DEST" -maxdepth 1 -type f -name 'd2d-*' -mtime +3 -delete
echo "Backup complete: $NAME"
