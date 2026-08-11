#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker required'; exit 1; }
test -f .env || { echo 'ERROR: copy .env.example to .env and configure it'; exit 1; }
docker network inspect netwatch-ai-network >/dev/null 2>&1 || docker network create netwatch-ai-network >/dev/null
docker compose build --no-cache backend
docker compose up -d --force-recreate postgres backend
echo 'Netwatch backend deployed. Health: http://127.0.0.1:3000/healthz'
