#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker required'; exit 1; }
test -f .env || { echo 'ERROR: copy .env.example to .env'; exit 1; }
test -s secrets/groq_api_key || { echo 'ERROR: create secrets/groq_api_key'; exit 1; }
chmod 600 secrets/groq_api_key
docker network inspect netwatch-ai-network >/dev/null 2>&1 || docker network create netwatch-ai-network >/dev/null
docker compose build --no-cache
docker compose up -d --force-recreate
echo 'AI Gateway deployed on port 3090.'
