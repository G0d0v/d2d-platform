#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd /opt/d2d/current
exec /usr/bin/node --env-file=/etc/d2d.env deploy/backup.mjs
