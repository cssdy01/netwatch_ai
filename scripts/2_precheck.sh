#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${NETWATCH_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FAIL=0; WARN=0
pass(){ printf '  [PASS] %s\n' "$*"; }
warn(){ printf '  [WARN] %s\n' "$*"; WARN=$((WARN+1)); }
fail(){ printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }
section(){ printf '\n%s\n' "$*"; printf '%*s\n' "${#1}" '' | tr ' ' '-'; }
value(){ sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1; }

printf '\nNetwatch precheck\n=================\nRoot: %s\n' "$APP_ROOT"
section 'Docker'
command -v docker >/dev/null 2>&1 && pass 'Docker command found.' || fail 'Docker command missing.'
docker compose version >/dev/null 2>&1 && pass 'Docker Compose plugin available.' || fail 'Docker Compose plugin unavailable.'
id -nG | tr ' ' '\n' | grep -qx docker && pass 'Current shell has docker group membership.' || warn 'Current shell is not in docker group. Run: newgrp docker'
docker info >/dev/null 2>&1 && pass 'Docker daemon accessible.' || fail 'Docker daemon inaccessible.'

section 'Project layout'
for dir in independent-ai-gateway backend frontend; do
  [ -d "$APP_ROOT/$dir" ] && pass "$dir directory found." || fail "$dir directory missing."
  [ -f "$APP_ROOT/$dir/compose.yaml" ] && pass "$dir/compose.yaml found." || fail "$dir/compose.yaml missing."
done

section 'Configuration'
for component in independent-ai-gateway backend; do
  [ -f "$APP_ROOT/$component/.env" ] && pass "$component/.env found." || fail "$component/.env missing."
done
[ -s "$APP_ROOT/independent-ai-gateway/secrets/groq_api_key" ] && pass 'Groq secret file configured.' || fail 'Gateway secrets/groq_api_key missing or empty.'

GATEWAY_ENV="$APP_ROOT/independent-ai-gateway/.env"
BACKEND_ENV="$APP_ROOT/backend/.env"
GTOKEN="$(value "$GATEWAY_ENV" NETWATCH_AI_SERVICE_TOKEN)"
BTOKEN="$(value "$BACKEND_ENV" NETWATCH_AI_SERVICE_TOKEN)"
if [ -n "$GTOKEN" ] && [ -n "$BTOKEN" ]; then
  GHASH="$(printf '%s' "$GTOKEN" | sha256sum | awk '{print $1}')"
  BHASH="$(printf '%s' "$BTOKEN" | sha256sum | awk '{print $1}')"
  [ "$GHASH" = "$BHASH" ] && pass 'Backend and Gateway service tokens match.' || fail 'Backend and Gateway service tokens do not match.'
else fail 'Service token is missing in Gateway or backend .env.'; fi
unset GTOKEN BTOKEN GHASH BHASH

for key in DB_HOST DB_NAME DB_USER DB_PASSWORD JWT_SECRET ADMIN_USER ADMIN_PASS AI_GATEWAY_URL AI_ENABLED; do
  [ -n "$(value "$BACKEND_ENV" "$key")" ] && pass "Backend $key configured." || fail "Backend $key missing."
done

section 'Networks'
for network in netwatch-network netwatch-ai-network; do
  docker network inspect "$network" >/dev/null 2>&1 && pass "$network exists." || warn "$network missing; setup or run console will create it."
done

section 'Source validation'
for component in independent-ai-gateway backend frontend; do
  if [ -x "$APP_ROOT/$component/validate.sh" ]; then
    if (cd "$APP_ROOT/$component" && ./validate.sh >/tmp/netwatch-${component}-validate.log 2>&1); then pass "$component validation passed."; else fail "$component validation failed; see /tmp/netwatch-${component}-validate.log"; fi
  else warn "$component/validate.sh not executable or missing."; fi
done

section 'Ports'
for port in 3000 3090 5432 8888; do
  if command -v ss >/dev/null 2>&1 && ss -lnt | awk '{print $4}' | grep -Eq "[:.]${port}$"; then warn "Port $port is already listening. This is expected when Netwatch is running."; else pass "Port $port is currently free."; fi
done

printf '\nSummary: %d failure(s), %d warning(s).\n' "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ] || exit 1
