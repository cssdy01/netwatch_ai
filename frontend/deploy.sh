#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker required'; exit 1; }
docker network inspect netwatch-network >/dev/null 2>&1 || docker network create netwatch-network >/dev/null
docker compose build --no-cache frontend
docker compose up -d --force-recreate frontend
echo "Frontend deployed: http://${FRONTEND_BIND:-192.168.111.22}:${FRONTEND_PORT:-8888}/"
