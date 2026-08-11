# Netwatch Platform 3.0
## Complete System Overview

Netwatch is a self-hosted infrastructure and application monitoring platform built around three primary components:

1. **Netwatch Frontend**
2. **Netwatch Backend**
3. **Independent AI Gateway**

The platform monitors servers, network devices, websites, APIs, and internal applications while providing incident management, alert escalation, reporting, auditing, backup capabilities, and optional AI-assisted analytics.

---

# Architecture Overview

```text
                        ┌─────────────────┐
                        │     Browser     │
                        └────────┬────────┘
                                 │
                                 ▼
                     ┌─────────────────────┐
                     │ Frontend (Nginx)    │
                     │ Port 8888           │
                     └────────┬────────────┘
                              │ /api/*
                              ▼
                 ┌────────────────────────────┐
                 │ Netwatch Backend           │
                 │ Node.js + Express          │
                 │ Port 3000                  │
                 └───────┬─────────┬──────────┘
                         │         │
                         │         │
                         ▼         ▼
              ┌────────────────┐  ┌─────────────────────┐
              │ PostgreSQL 16  │  │ AI Gateway          │
              │ Monitoring DB  │  │ Port 3090           │
              └────────────────┘  └─────────┬───────────┘
                                            │
                                            ▼
                                      ┌─────────┐
                                      │  Groq   │
                                      │  LLM    │
                                      └─────────┘
```

---

# Major Components

## 1. Frontend

Provides:

- Dashboard
- Task administration
- User management
- Monitoring views
- Incidents
- Logs
- Backup and restore operations
- AI chat interface

Runs behind:

```text
Nginx
Port: 8888
```

Responsibilities:

- UI rendering
- API proxying
- Authentication cookie handling
- AI chat widget

The frontend never directly accesses PostgreSQL or Groq.

---

# 2. Backend

The Backend is the core platform.

```text
Node.js 20
Express.js
PostgreSQL 16
```

Responsible for:

### Monitoring

- Ping monitoring
- HTTP/HTTPS monitoring
- API monitoring
- Application monitoring

### Incident Management

- Failure detection
- Threshold tracking
- Escalation processing
- Recovery notifications

### Authentication

- JWT authentication
- Role management
- Session handling

### Logging

- Application logs
- Audit logs
- Mail logs
- Backup logs

### AI Integration

- AI session lifecycle
- SQL validation
- Sanitization
- Data authorization

---

# 3. PostgreSQL Database

Stores all operational data.

Important tables:

| Table | Purpose |
|---|---|
| users | Accounts |
| tasks | Monitoring jobs |
| checks | Monitoring results |
| incident_state | Active incidents |
| app_logs | Application logs |
| audit_logs | Security and audit history |
| host_mappings | DNS/IP mappings |
| import_sessions | Import workflows |
| log_archives | Archive metadata |

---

# Core Monitoring System

## Supported Monitor Types

### Ping Monitor

Checks:

- Server availability
- VM availability
- Network devices
- Routers
- Switches

Uses:

```text
OS native ping command
```

Flow:

```text
Scheduler
   ↓
Ping Agent
   ↓
Result
   ↓
Database
   ↓
Incident Engine
```

---

### Application Monitor

Checks:

- Websites
- APIs
- Internal applications

Uses:

```text
Axios HTTP Client
```

Validates:

- HTTP status
- Response time
- DNS resolution
- TLS certificate validation
- Connectivity

Flow:

```text
Scheduler
   ↓
Web Agent
   ↓
Axios Request
   ↓
Pass/Fail
   ↓
Database
```

---

# Scheduler

Monitoring execution is controlled by:

```text
node-cron
```

Default:

```text
*/3 * * * *
```

Meaning:

```text
Every 3 minutes
```

Cycle:

```text
Load active tasks
      ↓
Check due tasks
      ↓
Run monitor
      ↓
Store result
      ↓
Evaluate incidents
```

---

# Incident Management

Netwatch uses an escalation hierarchy.

## L1

Triggered when:

```text
Failure threshold reached
```

Example:

```text
3 consecutive failures
```

Alert sent to:

```text
L1 contacts
```

---

## L2

Triggered after:

```text
L2 Delay
```

Default example:

```text
48 hours
```

Recipients:

```text
L1 + L2
```

---

## L3

Triggered repeatedly while incident exists.

Recipients:

```text
L1 + L2 + L3
```

Example:

```text
Every 48 hours
```

until service recovers.

---

## Recovery

When monitor succeeds:

```text
FAULT → OK
```

System:

- closes incident
- updates status
- sends all-clear email

---

# Email Alerting

Delivery pipeline:

```text
Backend
   ↓
mail/mailx
   ↓
Postfix
   ↓
SMTP Relay
```

Supports:

- L1 alerts
- L2 escalations
- L3 escalations
- Recovery notifications
- Test email

---

# Authentication and Security

## Roles

### Super Admin

Can:

- Manage users
- Manage all system configuration
- Access AI administrative views

### User

Can:

- Access monitoring features
- View logs
- Run tasks

---

## Login Process

```text
Email + Password
     ↓
bcrypt verification
     ↓
JWT generation
     ↓
HTTP-only cookie
```

Security controls:

- BCrypt password hashing
- Rate-limited login
- JWT in HTTP-only cookies
- Environment secret protection

---

# Host Mapping

Supports monitoring internal environments without modifying container hosts files.

Example:

```text
Hostname: api.internal.company
IP: 10.10.1.20
```

Netwatch can:

```text
api.internal.company
        ↓
10.10.1.20
```

while preserving:

- Host header
- TLS SNI

---

# Backup and Restore

## Export

Exports task configuration to:

```text
Excel (.xlsx)
```

---

## Import

Two-stage process:

```text
Import Preview
      ↓
Validation
      ↓
Apply Import
```

---

## Database Backup

Uses PostgreSQL tools:

```bash
pg_dump
pg_restore
```

---

# Logging

## Application Logs

Categories:

```text
SYSTEM
TASK
AUTH
EMAIL
BACKUP
ADMIN
```

Levels:

```text
INFO
WARN
ERROR
```

---

## Audit Logs

Track:

- Logins
- Logouts
- User changes
- Administrative actions

---

# AI Platform Overview

The AI subsystem is completely separated from database access.

Design principle:

```text
Model proposes
Backend decides
```

---

# AI Architecture

```text
User
 ↓
Frontend
 ↓
Backend /api/ai
 ↓
AI Gateway
 ↓
Groq
```

The AI Gateway:

- Understands questions
- Generates query plans
- Summarizes results
- Cannot connect to PostgreSQL
- Cannot modify data

---

# AI Security Model

The AI never receives:

- Passwords
- JWTs
- Cookies
- SMTP credentials
- Database credentials
- Service tokens
- Secret keys

All responses pass through multiple sanitization layers.

---

# AI Data Access Model

The backend exposes only approved views.

## Public Views

Examples:

```text
ai_public_task_details
ai_public_incident_timeline
ai_public_application_logs
```

---

## Authenticated Views

Includes public views plus:

```text
ai_authenticated_response_analytics
ai_authenticated_user_activity
```

---

## Super Admin Views

Includes:

```text
ai_superadmin_audit_summary
ai_superadmin_user_accounts
ai_superadmin_system_health
```

---

# AI Query Workflow

```text
User Question
      ↓
AI Gateway
      ↓
SQL_QUERY plan
      ↓
Backend Validation
      ↓
PostgreSQL Read-Only Query
      ↓
Sanitize Results
      ↓
AI Analysis
      ↓
Final Response
```

---

# AI SQL Protection

Allowed:

```sql
SELECT ...
```

Denied:

```sql
DELETE
UPDATE
INSERT
ALTER
DROP
```

Also denied:

- Base table access
- Multiple statements
- Dangerous functions
- Catalog access

Execution occurs inside:

```sql
BEGIN READ ONLY;
...
COMMIT;
```

---

# AI Gateway Responsibilities

The Independent AI Gateway is responsible for:

- Session management
- Prompt creation
- Structured output validation
- Query planning
- Query normalization
- Conversation context
- Groq communication
- Secondary sanitization

Technology:

```text
Node.js 20
Express.js
Ajv
Groq API
Docker Compose
```

---

# Networks

Three Docker networks are used.

## Frontend to Backend

```text
netwatch-network
```

## Backend to AI

```text
netwatch-ai-network
```

## Backend to PostgreSQL

```text
netwatch-internal
```

---

# Deployment Order

Recommended startup sequence:

```text
PostgreSQL
    ↓
AI Gateway
    ↓
Backend
    ↓
Frontend
```

---

# Health Checks

## Backend

```bash
curl http://localhost:3000/healthz
```

## AI Gateway

```bash
curl http://localhost:3090/healthz
```

## AI Status

```bash
curl http://localhost:8888/api/ai/status
```

---

# Key Features Summary

### Monitoring

- ICMP Ping monitoring
- HTTP/HTTPS monitoring
- API monitoring
- Host mapping

### Incident Management

- Threshold-based fault detection
- L1/L2/L3 escalations
- Recovery notifications

### Security

- JWT authentication
- Role-based access
- Audit logs
- Read-only AI architecture

### Operations

- PostgreSQL persistence
- Log archival
- Data pruning
- Excel import/export
- PostgreSQL backup

### AI

- Groq integration
- Session-based conversations
- Secure SQL planning
- Strict query validation
- Read-only access model
- Multi-stage sanitization

---

# End-to-End Workflow

```text
Monitor Target
      ↓
Scheduler
      ↓
Monitor Agent
      ↓
Check Result
      ↓
Database
      ↓
Incident Engine
      ↓
Email Notifications

                     User Question
                           ↓
                      AI Gateway
                           ↓
                     SQL Planning
                           ↓
                  Backend Validation
                           ↓
                    PostgreSQL Read
                           ↓
                      Sanitization
                           ↓
                     AI Analysis
                           ↓
                     Final Answer
```

This architecture ensures **Netwatch remains a secure monitoring platform with optional AI-assisted insights while maintaining strict separation between AI services, application logic, and database access.**
