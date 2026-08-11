#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${NETWATCH_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
AI="$ROOT/independent-ai-gateway"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
BACKUPS="$ROOT/backups/database"
EXPORTS="$ROOT/exports/images"
mkdir -p "$BACKUPS" "$EXPORTS"

ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
fail(){ printf '[FAIL] %s\n' "$*" >&2; return 1; }
line(){ printf '%s\n' '------------------------------------------------------------'; }
pause(){ printf '\nPress Enter to continue...'; IFS= read -r _ || true; }

compose(){ local dir="$1"; shift; (cd "$dir" && docker compose "$@"); }
service_id(){ compose "$1" ps -q "$2" 2>/dev/null | head -n 1; }
env_value(){ sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1 | sed 's/^"//;s/"$//'; }

check_runtime(){
  for file in "$AI/compose.yaml" "$BACKEND/compose.yaml" "$FRONTEND/compose.yaml"; do
    [ -f "$file" ] || { fail "Missing $file"; return 1; }
  done
  command -v docker >/dev/null 2>&1 || { fail 'Docker is not installed.'; return 1; }
  docker compose version >/dev/null 2>&1 || { fail 'Docker Compose plugin is unavailable.'; return 1; }
  docker info >/dev/null 2>&1 || { fail 'Docker is inaccessible. Run: newgrp docker'; return 1; }
}

networks(){
  local n
  for n in netwatch-network netwatch-ai-network; do
    docker network inspect "$n" >/dev/null 2>&1 || docker network create "$n" >/dev/null
  done
}

connect_network() {
  local container_id="$1"
  local network="$2"
  shift 2

  [ -n "$container_id" ] || {
    fail "Cannot connect an empty container ID to $network."
    return 1
  }

  local current aliases alias reconnect=0
  current="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$network\"}}{{json .Aliases}}{{end}}" "$container_id" 2>/dev/null || true)"

  if [ -n "$current" ]; then
    for alias in "$@"; do
      if ! printf '%s' "$current" | grep -Fq "\"$alias\""; then
        reconnect=1
      fi
    done

    if [ "$reconnect" -eq 0 ]; then
      return 0
    fi

    docker network disconnect "$network" "$container_id"
  fi

  local args=()
  for alias in "$@"; do
    args+=(--alias "$alias")
  done

  docker network connect "${args[@]}" "$network" "$container_id"
}

wait_service(){
  local name="$1" id="$2" tries="${3:-60}" state
  [ -n "$id" ] || { fail "$name container was not created."; return 1; }
  for ((i=1;i<=tries;i++)); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    case "$state" in
      healthy|running) ok "$name is $state."; return 0 ;;
      unhealthy|exited|dead) docker logs --tail 100 "$id" 2>/dev/null || true; fail "$name is $state."; return 1 ;;
    esac
    sleep 2
  done
  docker logs --tail 100 "$id" 2>/dev/null || true
  fail "$name startup timed out."
}

start_db(){
  line
  echo 'Starting PostgreSQL'
  line

  compose "$BACKEND" up -d postgres || return 1

  local db_id
  db_id="$(service_id "$BACKEND" postgres)"

  [ -n "$db_id" ] || {
    fail 'PostgreSQL container was not created.'
    return 1
  }

  wait_service PostgreSQL "$db_id" 60 || return 1
  ok 'PostgreSQL startup completed.'
}

start_ai(){
  line
  echo 'Starting AI Gateway'
  line

  compose "$AI" up -d independent-ai-gateway || return 1

  local ai_id
  ai_id="$(service_id "$AI" independent-ai-gateway)"

  [ -n "$ai_id" ] || {
    fail 'AI Gateway container was not created.'
    return 1
  }

  connect_network \
    "$ai_id" \
    netwatch-ai-network \
    independent-ai-gateway || return 1

  wait_service 'AI Gateway' "$ai_id" 45 || return 1
  ok 'AI Gateway startup completed.'
}

start_backend(){
  line
  echo 'Starting backend'
  line

  compose "$BACKEND" up -d backend || return 1

  local backend_id
  backend_id="$(service_id "$BACKEND" backend)"

  [ -n "$backend_id" ] || {
    fail 'Backend container was not created.'
    return 1
  }

  connect_network \
    "$backend_id" \
    netwatch-ai-network \
    netwatch-backend \
    backend || return 1

  connect_network \
    "$backend_id" \
    netwatch-network \
    netwatch-backend \
    backend || return 1

  wait_service Backend "$backend_id" 60 || return 1
  ok 'Backend startup completed.'
}

start_frontend(){
  line
  echo 'Starting frontend'
  line

  local backend_id
  backend_id="$(service_id "$BACKEND" backend)"

  [ -n "$backend_id" ] || {
    fail 'Backend must be running before the frontend starts.'
    return 1
  }

  connect_network \
    "$backend_id" \
    netwatch-network \
    netwatch-backend \
    backend || return 1

  compose "$FRONTEND" up -d --force-recreate frontend || return 1

  local frontend_id
  frontend_id="$(service_id "$FRONTEND" frontend)"

  [ -n "$frontend_id" ] || {
    fail 'Frontend container was not created.'
    return 1
  }

  connect_network \
    "$frontend_id" \
    netwatch-network \
    netwatch-frontend \
    frontend || return 1

  wait_service Frontend "$frontend_id" 45 || return 1

  if ! docker exec "$frontend_id" getent hosts netwatch-backend >/dev/null 2>&1; then
    docker logs --tail 100 "$frontend_id" 2>/dev/null || true
    fail 'Frontend cannot resolve the netwatch-backend Docker alias.'
    return 1
  fi

  if ! docker exec "$frontend_id" wget -qO- http://netwatch-backend:3000/healthz >/dev/null 2>&1; then
    docker logs --tail 100 "$frontend_id" 2>/dev/null || true
    fail 'Frontend cannot reach backend through netwatch-backend:3000.'
    return 1
  fi

  ok 'Frontend startup completed.'
}

start_all(){
  line
  echo 'START: PostgreSQL -> AI Gateway -> Backend -> Frontend'
  line

  networks || return 1
  start_db || return 1
  start_ai || return 1
  start_backend || return 1
  start_frontend || return 1
  health || return 1

  ok 'All Netwatch services started successfully.'
}

stop_apps(){ compose "$FRONTEND" stop frontend || true; compose "$BACKEND" stop backend || true; compose "$AI" stop independent-ai-gateway || true; ok 'Applications stopped; PostgreSQL kept running.'; }
stop_all(){ compose "$FRONTEND" stop frontend || true; compose "$BACKEND" stop backend postgres || true; compose "$AI" stop independent-ai-gateway || true; ok 'All services stopped.'; }
restart_all(){ stop_all; start_all; }

status(){
  line; printf '%-18s %-12s %-32s\n' COMPONENT STATE CONTAINER; line
  local dir service label id state name
  while IFS='|' read -r dir service label; do
    id="$(service_id "$dir" "$service")"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "$id")"
      name="$(docker inspect -f '{{.Name}}' "$id" | sed 's#^/##')"
    else state='absent'; name='-'; fi
    printf '%-18s %-12s %-32s\n' "$label" "$state" "$name"
  done <<EOF_STATUS
$BACKEND|postgres|PostgreSQL
$AI|independent-ai-gateway|AI Gateway
$BACKEND|backend|Backend
$FRONTEND|frontend|Frontend
EOF_STATUS
}

health(){
  local ai_url="http://${AI_BIND_ADDRESS:-192.168.111.22}:${AI_HOST_PORT:-3090}"
  local fe_url="http://${FRONTEND_BIND:-192.168.111.22}:${FRONTEND_PORT:-8888}"
  local failed=0

  line

  if curl -fsS --max-time 5 "$ai_url/healthz"; then
    echo
  else
    echo
    warn 'AI Gateway health check failed.'
    failed=1
  fi

  if curl -fsS --max-time 5 'http://127.0.0.1:3000/healthz'; then
    echo
  else
    echo
    warn 'Backend health check failed.'
    failed=1
  fi

  if curl -fsS --max-time 5 "$fe_url/healthz"; then
    echo
  else
    echo
    warn 'Frontend health check failed.'
    failed=1
  fi

  if curl -fsS --max-time 8 "$fe_url/api/ai/status"; then
    echo
  else
    echo
    warn 'Frontend AI status check failed.'
    failed=1
  fi

  [ "$failed" -eq 0 ] || {
    fail 'One or more health checks failed.'
    return 1
  }

  ok 'All health checks passed.'
}

build_one(){ echo "Building $2 without cache..."; compose "$1" build --no-cache "$2"; }
build_all(){ build_one "$AI" independent-ai-gateway; build_one "$BACKEND" backend; build_one "$FRONTEND" frontend; }
logs(){ compose "$1" logs --tail 300 -f "$2"; }
shell_service(){ compose "$1" exec "$2" sh; }

db_backup(){
  local id db user file
  id="$(service_id "$BACKEND" postgres)"; [ -n "$id" ] || { fail 'PostgreSQL is not running.'; return 1; }
  db="$(env_value "$BACKEND/.env" DB_NAME)"; user="$(env_value "$BACKEND/.env" DB_USER)"
  [ -n "$db" ] && [ -n "$user" ] || { fail 'DB_NAME or DB_USER missing.'; return 1; }
  file="$BACKUPS/netwatch-$(date +%Y%m%d-%H%M%S).dump"
  docker exec "$id" pg_dump -U "$user" -d "$db" -Fc > "$file"
  chmod 600 "$file"; ok "Backup: $file"
}

db_restore(){
  local file answer id db user
  find "$BACKUPS" -maxdepth 1 -type f -name '*.dump' -printf '%f\n' | sort -r
  printf 'Backup filename, or blank to cancel: '; IFS= read -r file
  [ -n "$file" ] || return 0; [ -f "$BACKUPS/$file" ] || { fail 'Backup not found.'; return 1; }
  printf 'Type RESTORE to continue: '; IFS= read -r answer; [ "$answer" = RESTORE ] || return 0
  id="$(service_id "$BACKEND" postgres)"; db="$(env_value "$BACKEND/.env" DB_NAME)"; user="$(env_value "$BACKEND/.env" DB_USER)"
  compose "$BACKEND" stop backend || true
  docker exec "$id" dropdb -U "$user" --if-exists "$db"
  docker exec "$id" createdb -U "$user" "$db"
  docker exec -i "$id" pg_restore -U "$user" -d "$db" --no-owner < "$BACKUPS/$file"
  compose "$BACKEND" up -d backend
}

db_shell(){ local id db user; id="$(service_id "$BACKEND" postgres)"; db="$(env_value "$BACKEND/.env" DB_NAME)"; user="$(env_value "$BACKEND/.env" DB_USER)"; docker exec -it "$id" psql -U "$user" -d "$db"; }
list_images(){ docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}' | grep -E 'REPOSITORY|netwatch|independent-ai' || true; }
export_images(){ local file images; file="$EXPORTS/netwatch-images-$(date +%Y%m%d-%H%M%S).tar"; images="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(independent-ai-gateway|netwatch-backend|netwatch-frontend):' | sort -u || true)"; [ -n "$images" ] || { fail 'No images found.'; return 1; }; docker save -o "$file" $images; ok "Export: $file"; }
import_images(){ local file; find "$EXPORTS" -maxdepth 1 -type f -name '*.tar' -printf '%f\n' | sort -r; printf 'Archive filename: '; IFS= read -r file; [ -n "$file" ] && docker load -i "$EXPORTS/$file"; }
remove_containers(){ compose "$FRONTEND" down --remove-orphans || true; compose "$AI" down --remove-orphans || true; compose "$BACKEND" rm -sf backend || true; }
remove_images(){ remove_containers; docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(independent-ai-gateway|netwatch-backend|netwatch-frontend):' | xargs -r docker image rm; }
prune(){ local answer; printf 'Type PRUNE: '; IFS= read -r answer; [ "$answer" = PRUNE ] && docker system prune -f || warn 'Cancelled.'; }
wipe(){ local answer; db_backup || true; printf 'Type WIPE-NETWATCH-DATA: '; IFS= read -r answer; [ "$answer" = WIPE-NETWATCH-DATA ] || return 0; compose "$FRONTEND" down || true; compose "$AI" down || true; compose "$BACKEND" down -v || true; remove_images || true; }
tokens(){ local a b; a="$(env_value "$AI/.env" NETWATCH_AI_SERVICE_TOKEN)"; b="$(env_value "$BACKEND/.env" NETWATCH_AI_SERVICE_TOKEN)"; [ -n "$a" ] && [ "$(printf %s "$a"|sha256sum)" = "$(printf %s "$b"|sha256sum)" ] && ok 'Tokens match.' || fail 'Tokens differ or are missing.'; unset a b; }

menu(){
  printf '\nNETWATCH STACK MANAGEMENT\nRoot: %s\n' "$ROOT"
  cat <<'MENU'
------------------------------------------------------------
 1 Start all                 2 Stop apps, keep DB
 3 Stop all                  4 Restart all
 5 Status                    6 Health
 7 AI logs                   8 Backend logs
 9 Frontend logs            10 PostgreSQL logs
11 AI shell                 12 Backend shell
13 PostgreSQL shell         14 Build all
15 Build AI                 16 Build backend
17 Build frontend           18 List images
19 Export images            20 Import images
21 DB backup                22 DB restore
23 Full precheck            24 Check AI tokens
25 Restart AI               26 Restart backend
27 Restart frontend         28 Remove app containers
29 Remove app images        30 Docker prune
31 Full wipe                 0 Exit
------------------------------------------------------------
MENU
}

run(){
  case "$1" in
    1|start) start_all;; 2|stop-app) stop_apps;; 3|stop) stop_all;; 4|restart) restart_all;;
    5|status) status;; 6|health) health;; 7|logs-ai) logs "$AI" independent-ai-gateway;;
    8|logs-backend) logs "$BACKEND" backend;; 9|logs-frontend) logs "$FRONTEND" frontend;; 10|logs-db) logs "$BACKEND" postgres;;
    11|shell-ai) shell_service "$AI" independent-ai-gateway;; 12|shell-backend) shell_service "$BACKEND" backend;; 13|shell-db) db_shell;;
    14|build) build_all;; 15|build-ai) build_one "$AI" independent-ai-gateway;; 16|build-backend) build_one "$BACKEND" backend;; 17|build-frontend) build_one "$FRONTEND" frontend;;
    18|images) list_images;; 19|export-images) export_images;; 20|import-images) import_images;;
    21|backup-db) db_backup;; 22|restore-db) db_restore;; 23|validate) bash "$SCRIPT_DIR/2_precheck.sh";; 24|tokens) tokens;;
    25|restart-ai) compose "$AI" restart independent-ai-gateway;; 26|restart-backend) compose "$BACKEND" restart backend;; 27|restart-frontend) compose "$FRONTEND" restart frontend;;
    28|remove-containers) remove_containers;; 29|remove-images) remove_images;; 30|prune) prune;; 31|wipe) wipe;;
    0|exit) return 10;; *) warn "Invalid option: $1"; return 2;;
  esac
}

main(){
  check_runtime
  if [ "$#" -gt 0 ]; then run "$1"; return $?; fi
  while true; do
    menu
    printf 'Choose [0-31]: '
    IFS= read -r choice || { echo; return 0; }
    choice="${choice//[[:space:]]/}"
    [ -n "$choice" ] || { warn 'No selection.'; continue; }
    if run "$choice"; then
      rc=0
    else
      rc=$?
    fi
    [ "$rc" -eq 10 ] && return 0
    case "$choice" in 7|8|9|10|11|12|13) ;; *) pause;; esac
  done
}

main "$@"
