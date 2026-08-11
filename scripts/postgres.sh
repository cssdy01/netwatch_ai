#!/usr/bin/env bash
# =============================================================================
# postgres.sh — NetWatch PostgreSQL management console
#
# Usage:
#   ./postgres.sh start
#   ./postgres.sh stop
#   ./postgres.sh restart
#   ./postgres.sh status
#   ./postgres.sh health
#   ./postgres.sh logs
#   ./postgres.sh console
#   ./postgres.sh shell
#   ./postgres.sh databases
#   ./postgres.sh users
#   ./postgres.sh backup
#   ./postgres.sh export
#   ./postgres.sh restore <backup-file>
#   ./postgres.sh vacuum
#   ./postgres.sh help
#
# The script reads DB_* values from ../backend/.env and uses the Docker
# Compose project in ../backend.
# =============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWATCH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$NETWATCH_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"
BACKUP_DIR="$NETWATCH_ROOT/backups/postgres"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

die() {
  echo -e "${RED}ERROR:${NC} $*" >&2
  exit 1
}

ok()   { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
info() { echo -e "${CYAN}$*${NC}"; }

usage() {
  cat <<EOF

${BOLD}NetWatch PostgreSQL Management${NC}

Usage:
  $0 <command>

Commands:
  start                    Start PostgreSQL
  stop                     Stop PostgreSQL
  restart                  Restart PostgreSQL
  status                   Show PostgreSQL/container status
  health                   Check PostgreSQL health
  logs                     Follow PostgreSQL logs
  console                  Open psql console
  shell                    Open shell inside PostgreSQL container
  databases                List databases
  users                    List PostgreSQL users/roles
  backup                   Create compressed custom-format backup
  export                   Create plain SQL export
  restore <file>           Restore a .dump/.backup/.sql file
  vacuum                   Run VACUUM (ANALYZE)
  help                     Show this help

Examples:
  $0 status
  $0 console
  $0 backup
  $0 export
  $0 restore backups/postgres/netwatch_2026-08-11_153000.dump

EOF
}

require_commands() {
  command -v docker >/dev/null 2>&1 || die "docker command not found."
  docker compose version >/dev/null 2>&1 || die "Docker Compose is not available."
  [ -f "$ENV_FILE" ] || die "Environment file not found: $ENV_FILE"
  [ -d "$BACKEND_DIR" ] || die "Backend directory not found: $BACKEND_DIR"
}

read_env() {
  # Read only simple KEY=value entries needed by this script.
  # Do not source .env because it may contain values/characters that should
  # not be executed as shell code.
  DB_NAME="$(sed -n 's/^DB_NAME=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"
  DB_USER="$(sed -n 's/^DB_USER=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"
  DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"
  DB_HOST="$(sed -n 's/^DB_HOST=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"
  DB_PORT="$(sed -n 's/^DB_PORT=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"

  DB_NAME="${DB_NAME%\"}"; DB_NAME="${DB_NAME#\"}"
  DB_USER="${DB_USER%\"}"; DB_USER="${DB_USER#\"}"
  DB_PASSWORD="${DB_PASSWORD%\"}"; DB_PASSWORD="${DB_PASSWORD#\"}"
  DB_HOST="${DB_HOST%\"}"; DB_HOST="${DB_HOST#\"}"
  DB_PORT="${DB_PORT%\"}"; DB_PORT="${DB_PORT#\"}"

  DB_NAME="${DB_NAME:-netwatch}"
  DB_USER="${DB_USER:-netwatch}"
  DB_HOST="${DB_HOST:-postgres}"
  DB_PORT="${DB_PORT:-5432}"

  [ -n "$DB_PASSWORD" ] || die "DB_PASSWORD is missing from $ENV_FILE"
}

compose() {
  (cd "$BACKEND_DIR" && docker compose "$@")
}

postgres_container() {
  # Prefer the Compose service container, then fall back to the known name.
  local id
  id="$(compose ps -q postgres 2>/dev/null || true)"
  if [ -n "$id" ]; then
    echo "$id"
    return 0
  fi

  docker ps -q --filter "name=backend-postgres-1" | head -1
}

require_container() {
  local c
  c="$(postgres_container)"
  [ -n "$c" ] || die "PostgreSQL container is not running/created."
  echo "$c"
}

ensure_backup_dir() {
  mkdir -p "$BACKUP_DIR" || die "Cannot create backup directory: $BACKUP_DIR"
}

cmd_start() {
  compose up -d postgres
  ok "PostgreSQL started."
  cmd_health
}

cmd_stop() {
  compose stop postgres
  ok "PostgreSQL stopped."
}

cmd_restart() {
  compose restart postgres
  ok "PostgreSQL restarted."
  cmd_health
}

cmd_status() {
  echo
  info "PostgreSQL container:"
  compose ps postgres || true

  echo
  info "Docker container:"
  local c
  c="$(postgres_container)"
  if [ -n "$c" ]; then
    docker inspect "$c" \
      --format 'Name={{.Name}} Status={{.State.Status}} Health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
      2>/dev/null || true
  else
    warn "PostgreSQL container not found."
  fi
}

cmd_health() {
  local c
  c="$(require_container)"

  if docker exec \
      -e PGPASSWORD="$DB_PASSWORD" \
      "$c" pg_isready -U "$DB_USER" -d "$DB_NAME" -h 127.0.0.1 -p "$DB_PORT" >/dev/null 2>&1; then
    ok "PostgreSQL is healthy: $DB_NAME / $DB_USER"
  else
    die "PostgreSQL health check failed."
  fi
}

cmd_logs() {
  compose logs -f --tail=100 postgres
}

cmd_console() {
  local c
  c="$(require_container)"
  docker exec -it \
    -e PGPASSWORD="$DB_PASSWORD" \
    "$c" psql -U "$DB_USER" -d "$DB_NAME"
}

cmd_shell() {
  local c
  c="$(require_container)"
  docker exec -it "$c" sh
}

cmd_databases() {
  local c
  c="$(require_container)"
  docker exec \
    -e PGPASSWORD="$DB_PASSWORD" \
    "$c" psql -U "$DB_USER" -d "$DB_NAME" \
    -c '\l'
}

cmd_users() {
  local c
  c="$(require_container)"
  docker exec \
    -e PGPASSWORD="$DB_PASSWORD" \
    "$c" psql -U "$DB_USER" -d "$DB_NAME" \
    -c '\du'
}

cmd_backup() {
  local c stamp file
  c="$(require_container)"
  ensure_backup_dir
  cmd_health >/dev/null

  stamp="$(date '+%Y-%m-%d_%H%M%S')"
  file="$BACKUP_DIR/${DB_NAME}_${stamp}.dump"

  info "Creating PostgreSQL custom-format backup..."
  if docker exec \
      -e PGPASSWORD="$DB_PASSWORD" \
      "$c" pg_dump \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      -Fc \
      --no-owner \
      --no-acl \
      > "$file"; then
    ok "Backup created: $file"
    ls -lh "$file"
  else
    rm -f "$file"
    die "Backup failed."
  fi
}

cmd_export() {
  local c stamp file
  c="$(require_container)"
  ensure_backup_dir
  cmd_health >/dev/null

  stamp="$(date '+%Y-%m-%d_%H%M%S')"
  file="$BACKUP_DIR/${DB_NAME}_${stamp}.sql"

  info "Creating plain SQL export..."
  if docker exec \
      -e PGPASSWORD="$DB_PASSWORD" \
      "$c" pg_dump \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      --no-owner \
      --no-acl \
      > "$file"; then
    ok "SQL export created: $file"
    ls -lh "$file"
  else
    rm -f "$file"
    die "SQL export failed."
  fi
}

cmd_restore() {
  local file="$1"
  local c ext answer

  [ -n "$file" ] || die "Usage: $0 restore <backup-file>"
  [ -f "$file" ] || die "Backup file not found: $file"

  c="$(require_container)"
  cmd_health >/dev/null

  echo
  warn "WARNING: This restore can overwrite existing objects/data."
  echo "Database : $DB_NAME"
  echo "User     : $DB_USER"
  echo "File     : $file"
  echo
  read -r -p "Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || {
    warn "Restore cancelled."
    return 0
  }

  ext="${file##*.}"

  case "$ext" in
    dump|backup)
      info "Restoring custom-format backup..."
      docker exec -i \
        -e PGPASSWORD="$DB_PASSWORD" \
        "$c" pg_restore \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists \
        < "$file"
      ;;
    sql)
      info "Restoring plain SQL export..."
      docker exec -i \
        -e PGPASSWORD="$DB_PASSWORD" \
        "$c" psql \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -v ON_ERROR_STOP=1 \
        < "$file"
      ;;
    *)
      die "Unsupported file extension .$ext. Use .dump, .backup, or .sql"
      ;;
  esac

  ok "Restore completed."
}

cmd_vacuum() {
  local c
  c="$(require_container)"
  cmd_health >/dev/null

  info "Running VACUUM (ANALYZE)..."
  docker exec \
    -e PGPASSWORD="$DB_PASSWORD" \
    "$c" vacuumdb \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --analyze
  ok "VACUUM (ANALYZE) completed."
}

main() {
  require_commands
  read_env

  case "${1:-help}" in
    start)              cmd_start ;;
    stop)               cmd_stop ;;
    restart)            cmd_restart ;;
    status)             cmd_status ;;
    health)             cmd_health ;;
    logs)               cmd_logs ;;
    console|psql)       cmd_console ;;
    shell)              cmd_shell ;;
    databases|dbs)      cmd_databases ;;
    users|roles)        cmd_users ;;
    backup)             cmd_backup ;;
    export)             cmd_export ;;
    restore)            shift; cmd_restore "${1:-}" ;;
    vacuum)             cmd_vacuum ;;
    help|-h|--help)     usage ;;
    *)                  echo "Unknown command: $1"; usage; exit 1 ;;
  esac
}

main "$@"
