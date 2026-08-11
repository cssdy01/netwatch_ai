# Netwatch Backend 3.0: System and Operations Guide

Netwatch is a lightweight, self-hosted monitoring platform for infrastructure, network devices, websites, APIs, and internal applications. The backend provides monitoring execution, incident management, alert escalation, authentication, task administration, logs, audit trails, host mappings, backup/import operations, PostgreSQL persistence, and optional read-only AI integration.

This document describes the **core backend system**. AI-specific integration is documented separately in `README-AI-INTEGRATION.md`.

---

## 1. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| API framework | Express.js |
| Database | PostgreSQL 16 |
| PostgreSQL client | `pg` |
| Authentication | JWT in HTTP-only cookies |
| Password hashing | `bcryptjs` |
| Monitoring scheduler | `node-cron` |
| HTTP monitoring | Axios |
| Ping monitoring | Native operating-system `ping` command |
| Mail | `mail` / `mailx` / `bsd-mailx` with local Postfix relay |
| Spreadsheet export/import | `exceljs` |
| Deployment | Docker Compose |
| Frontend proxy | Nginx |

> Netwatch 3.0 uses PostgreSQL. The older SQLite and `better-sqlite3` references no longer apply.

---

## 2. High-Level Architecture

```text
Browser
  |
  v
Frontend Nginx :8888
  |  /api/* proxy
  v
Netwatch Backend :3000
  |
  +-- Authentication and role checks
  +-- Task CRUD and public dashboard APIs
  +-- Monitoring scheduler
  +-- Ping and application agents
  +-- Incident and escalation engine
  +-- Mail delivery
  +-- Logs, audit, archives, backup/import
  +-- Optional AI adapter
  |
  v
PostgreSQL 16
```

Docker networks normally provide these paths:

```text
Frontend <-> Backend       netwatch-network
Backend  <-> AI Gateway    netwatch-ai-network
Backend  <-> PostgreSQL    backend_netwatch-internal
```

The backend should have the Docker DNS aliases `netwatch-backend` and `backend` on `netwatch-network`, allowing frontend Nginx to use:

```text
http://netwatch-backend:3000
```

---

## 3. Startup Lifecycle

`src/index.js` performs the following sequence:

1. Loads environment variables.
2. Initializes Express and middleware.
3. Initializes the PostgreSQL adapter and schema.
4. Verifies required administrator and JWT settings.
5. Creates or updates the environment-defined Super Admin account.
6. Starts the HTTP server.
7. Starts the monitoring, escalation, pruning, and archive schedules.

The recommended service startup order is:

```text
PostgreSQL -> AI Gateway -> Backend -> Frontend
```

PostgreSQL must become healthy before the backend starts.

---

## 4. PostgreSQL Database

### 4.1 Connection

The backend requires:

```dotenv
DB_HOST=postgres
DB_PORT=5432
DB_NAME=netwatch
DB_USER=netwatch
DB_PASSWORD=CHANGE_ME
DB_SSL=false
DB_POOL_MAX=10
DB_CONNECT_TIMEOUT_SEC=120
DB_QUERY_TIMEOUT_MS=60000
```

Database operations are handled by `src/db.js`. A worker-thread compatibility adapter allows the existing synchronous-style repository calls to use PostgreSQL safely without blocking the main Express event loop while a query is in progress.

### 4.2 Core tables

| Table | Purpose |
|---|---|
| `schema_metadata` | Application and schema version tracking |
| `users` | User identities, password hashes, and roles |
| `tasks` | Ping and application monitor definitions |
| `checks` | Individual PASS/FAIL monitoring results |
| `incident_state` | Open incident and L1/L2/L3 escalation state |
| `app_logs` | System, task, mail, admin, and backup logs |
| `audit_logs` | Authentication and user/admin actions |
| `log_archives` | Metadata for exported log archives |
| `import_sessions` | Temporary validated import previews |
| `host_mappings` | Managed hostname-to-IP mappings |

### 4.3 Data types and indexes

PostgreSQL timestamps use `TIMESTAMPTZ`. Frequently queried fields such as task ID, check time, log time, category, level, task status, and task type are indexed.

### 4.4 Data persistence

Docker volumes:

```text
backend_netwatch-db     PostgreSQL data
backend_netwatch-data   backend runtime files and log archives
```

Removing a container does not remove these volumes. `docker compose down -v` does.

---

## 5. Monitoring Tasks

Netwatch supports two task types:

```text
PING
APPLICATION
```

Common task settings include:

- Task name
- Type
- Target or URL
- Active state
- Monitoring interval
- Failure threshold
- Expected HTTP status
- Request timeout
- L1, L2, and L3 notification contacts
- L2 delay and L3 repeat interval
- Email enabled state
- Optional hostname mapping

Monitoring intervals are normalized to the configured minimum and maximum. The current implementation defaults to a scheduler cycle every three minutes and enforces task intervals between three and fifteen minutes.

---

## 6. System and Ping Monitoring

`src/agents/pingAgent.js` monitors servers, VMs, and network devices through the operating system's native `ping` utility.

### Workflow

```text
Scheduler selects PING task
  -> Native ping command is executed
  -> Output and exit status are parsed
  -> Response time and error details are normalized
  -> PASS or FAIL result is returned
  -> Result is written to checks
  -> Incident state is evaluated
```

A check fails when the host is unreachable, packet delivery fails, the command exits unsuccessfully, or the configured timeout is exceeded.

Using the native `ping` command avoids implementing raw ICMP sockets inside Node.js and works well in the supplied Docker image, which includes `iputils-ping`.

---

## 7. Application and HTTP Monitoring

`src/agents/webAgent.js` monitors websites, APIs, and internal applications.

### Workflow

```text
Scheduler selects APPLICATION task
  -> URL and optional host mapping are prepared
  -> HTTP GET request is sent with Axios
  -> Status, latency, TLS, timeout, and connectivity are evaluated
  -> PASS or FAIL result is returned
  -> Result is written to checks
  -> Incident state is evaluated
```

### Failure conditions

- Expected status is not returned
- Connection cannot be established
- DNS resolution fails
- TLS verification fails
- Request exceeds the configured timeout
- The remote endpoint closes or rejects the connection

### Dynamic hostname mapping

For an internal hostname that must connect to a specific IP address, Netwatch can preserve the original hostname while routing to the configured address. This supports correct HTTP `Host` handling and TLS Server Name Indication without modifying `/etc/hosts` in the container.

Task fields include:

```text
host_mapping_enabled
host_mapping_hostname
host_mapping_ip
```

A separate host-mapping API also manages reusable mappings.

---

## 8. Scheduler and Check Execution

`src/services/monitoringService.js` owns the scheduling workflow.

### Poll cycle

The default cron expression is:

```dotenv
POLL_CYCLE_CRON=*/3 * * * *
```

Each cycle:

1. Loads active, non-deleted tasks.
2. Checks whether each task is due according to `interval_min` and `last_checked`.
3. Dispatches the task to the correct agent.
4. Stores the result in `checks`.
5. Updates task status and consecutive failure count.
6. Opens, escalates, or closes an incident.

An overlap guard prevents a new poll cycle from starting while the previous cycle is still running.

### Manual test versus manual run

- `POST /api/tasks/test` tests supplied task settings without creating a normal monitoring record or sending alert email.
- `POST /api/tasks/:id/run` runs an existing task immediately and follows the normal stored-task execution path.

---

## 9. Incident and Escalation Engine

A task enters `FAULT` after consecutive failures meet its configured `n_threshold`.

### Incident creation

```text
PASS -> no incident
FAIL below threshold -> increment consecutive failure count
FAIL at threshold -> task becomes FAULT and incident_state is opened
```

`incident_state` records:

- Incident start time (`t0`)
- L1 sent time
- L2 sent time
- L3 first sent time
- Last L3 repeat time
- Whether an alert was sent
- Alerted tiers

### L1

L1 is sent when a new incident reaches the failure threshold, subject to email being enabled and an L1 cooldown. The cooldown helps suppress repeated immediate alerts.

### L2

L2 is sent when the incident remains unresolved for `l2_delay_min`. The common default is 2,880 minutes, or 48 hours.

### L3

After L2, L3 is repeated while the incident remains open. `l3_repeat_min` controls the repeat interval, with a common default of 2,880 minutes.

### Recovery

When the next successful check arrives:

1. The task returns to `OK`.
2. The incident is closed and removed from `incident_state`.
3. If alerting occurred, an All Clear message is sent.
4. The recovery log records incident resolution.

---

## 10. Mail and Alert Delivery

Mail handling is split between:

```text
src/mail/mailService.js
src/mail/transport.js
```

### Recipient expansion

```text
L1 -> L1 recipients
L2 -> L1 + L2 recipients
L3 -> L1 + L2 + L3 recipients
Recovery -> all configured recipients
```

Duplicate addresses are removed.

### Transport

The backend detects a supported `mail`, `mailx`, or `bsd-mailx` binary, then spawns it as a child process. The container's Postfix instance relays mail to the configured relay.

Typical settings:

```dotenv
POSTFIX_RELAY=172.17.0.1:25
MAIL_FROM_NAME=NetWatch Monitor
MAIL_FROM_EMAIL=alerts@example.com
```

HTML mail is used when the installed mailx supports custom headers; otherwise the transport falls back to plain text.

### Test mail

Authenticated administrators can call:

```text
POST /api/logs/test-email
```

This explicit test path is never called by the scheduler.

---

## 11. Authentication and Authorization

### Login

```text
POST /api/auth/login
```

The backend verifies the password with `bcryptjs`, creates a JWT, and stores it in an HTTP-only cookie.

### Current user

```text
GET /api/auth/me
```

### Logout

```text
POST /api/auth/logout
```

The authentication controller clears the cookie and records the event.

### Roles

```text
superadmin
user
```

Super Admin access is required for user administration. Authenticated users can access protected task, log, backup, and host-mapping APIs according to controller policy.

### Startup administrator

The backend requires:

```dotenv
ADMIN_USER=admin@example.com
ADMIN_PASS=CHANGE_ME
JWT_SECRET=AT_LEAST_32_RANDOM_CHARACTERS
```

At startup, the Super Admin account is created or synchronized from these values.

### Security controls

- Passwords are stored only as bcrypt hashes.
- JWTs are stored in HTTP-only cookies.
- Login attempts are rate-limited.
- Sensitive environment values are not returned by APIs.
- AI access never exposes passwords, hashes, tokens, or credentials.

---

## 12. Logging and Auditing

### Application logs

`app_logs` stores operational events with categories such as:

```text
TASK
ADMIN
AUTH
SYSTEM
EMAIL
BACKUP
```

Levels:

```text
INFO
WARN
ERROR
```

### Audit logs

`audit_logs` tracks security and administrative activity, including authentication events and changes initiated by users.

### Log APIs

```text
GET  /api/logs/app
GET  /api/logs/audit
GET  /api/logs/download
GET  /api/logs/archives
POST /api/logs/archives/trigger
GET  /api/logs/archives/:id/download
POST /api/logs/test-email
GET  /api/logs/health
```

### Retention

The daily pruner deletes old checks, application logs, and audit logs according to `PRUNE_DAYS`, commonly 60 days.

### Archive schedule

The archive schedule runs at 23:58 IST, represented in UTC cron as:

```text
28 18 * * *
```

Archive metadata is stored in `log_archives`, while files are written to the configured archive directory.

---

## 13. Task Administration APIs

### Public dashboard

```text
GET /api/tasks/public/summary
GET /api/tasks/public/:id
```

These endpoints provide approved monitoring information without requiring an administrator session.

### Authenticated task management

```text
GET    /api/tasks
GET    /api/tasks/bin
GET    /api/tasks/:id
POST   /api/tasks
PUT    /api/tasks/:id
DELETE /api/tasks/:id
POST   /api/tasks/:id/restore
DELETE /api/tasks/:id/hard
POST   /api/tasks/:id/run
POST   /api/tasks/test
PATCH  /api/tasks/:id/email-toggle
PATCH  /api/tasks/:id/active-toggle
```

Deletion is soft by default. The recycle-bin endpoint exposes deleted tasks for restoration or permanent removal.

---

## 14. User APIs

Super Admin only:

```text
GET    /api/users
POST   /api/users
PUT    /api/users/:id
DELETE /api/users/:id
```

User records include email, password hash, role, and creation time. The password hash is never returned as an approved AI field.

---

## 15. Host-Mapping APIs

Authenticated users:

```text
GET    /api/host-mappings
GET    /api/host-mappings/:id
POST   /api/host-mappings
PUT    /api/host-mappings/:id
DELETE /api/host-mappings/:id
```

These APIs support controlled hostname and IP mappings for internal monitoring targets.

---

## 16. Backup, Export, and Import

The application backup feature exports monitoring configuration to Excel. This is separate from a full PostgreSQL database backup.

### Export

```text
GET /api/backup/export
```

Exports monitoring task configuration to an `.xlsx` file.

### Import preview

```text
POST /api/backup/import-preview
```

The uploaded workbook is parsed and validated. A temporary `import_sessions` record stores the preview and expiration time.

### Apply import

```text
POST /api/backup/import-apply
```

The administrator chooses which Ping and Application records to apply.

### Full database backup

For disaster recovery, use PostgreSQL tools:

```bash
pg_dump -Fc
pg_restore
```

The stack-management scripts store custom-format database backups under:

```text
backups/database/
```

---

## 17. Health Endpoint

```text
GET /healthz
```

Example:

```json
{
  "status": "ok",
  "service": "netwatch-backend",
  "timezone": "Asia/Kolkata (IST)",
  "ai": {
    "enabled": true,
    "configured": true
  }
}
```

The health endpoint confirms the process is serving requests. Component-specific log and mail health data is available through protected log APIs.

---

## 18. Core Monitoring Workflow

```text
Cron scheduler
  -> Load active tasks
  -> Determine which tasks are due
  -> Dispatch PING or APPLICATION agent
  -> Normalize PASS/FAIL result
  -> Insert checks row
  -> Update task status and failure counter
  -> Failure threshold reached?
       No  -> finish
       Yes -> open incident and send L1
  -> Escalation scheduler
       -> send L2 after configured delay
       -> send repeated L3 while unresolved
  -> Successful check after incident
       -> restore OK state
       -> send All Clear
       -> close incident
```

---

## 19. Deployment

Typical commands:

```bash
cp .env.example .env
./validate.sh
./deploy.sh
```

Or use the central stack manager:

```bash
cd ../scripts
./3_run.sh build
./3_run.sh start
./3_run.sh health
```

### Required networks

```bash
docker network create netwatch-network
docker network create netwatch-ai-network
```

### Recommended backend network aliases

The backend should be declared on both external networks:

```yaml
networks:
  netwatch-ai-network:
    aliases:
      - netwatch-backend
      - backend
  netwatch-network:
    aliases:
      - netwatch-backend
      - backend
```

---

## 20. Operational Checks

```bash
curl -sS http://127.0.0.1:3000/healthz

docker compose ps

docker compose logs --tail=200 backend

docker compose exec postgres \
  psql -U "$DB_USER" -d "$DB_NAME"
```

From the frontend container:

```bash
getent hosts netwatch-backend
wget -qO- http://netwatch-backend:3000/healthz
```

---

## 21. Feature Summary

- ICMP Ping monitoring
- HTTP and HTTPS monitoring
- Configurable intervals and thresholds
- Dynamic hostname mapping
- PostgreSQL persistence
- L1, L2, and repeated L3 escalation
- Recovery notifications
- Postfix and mailx delivery
- JWT authentication
- HTTP-only cookies
- Role-based user administration
- Public and protected task APIs
- Application logs and audit logs
- Daily pruning and log archives
- Excel export and validated import
- PostgreSQL backup and restore support
- Docker deployment and health checks
- Optional read-only SQL-planning AI integration
