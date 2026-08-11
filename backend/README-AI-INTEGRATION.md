# Netwatch Backend 3.0: AI Integration Guide

This document explains how the Netwatch backend integrates with the independent AI Gateway, validates AI-generated PostgreSQL plans, executes approved read-only queries, sanitizes results, and returns final conversational responses to the frontend.

The core monitoring system is documented in `README-SYSTEM.md`.

---

## 1. Design Goals

The AI feature was added without giving the model or browser direct database access.

The design enforces these boundaries:

```text
Frontend cannot see proposed SQL.
AI Gateway cannot connect to PostgreSQL.
Groq cannot connect to PostgreSQL.
Backend does not trust Gateway validation.
Only approved read-only views can be queried.
Results are sanitized before leaving the backend.
Monitoring controls remain outside AI access.
```

The feature is informational and read-only. It cannot create, update, delete, enable, disable, restore, import, send mail, or change Netwatch configuration.

---

## 2. End-to-End Architecture

```text
User
  -> Frontend AI widget
  -> Backend /api/ai
  -> AI Gateway /v1
  -> Groq planning request
  <- MESSAGE, CLARIFICATION, DENIED, or SQL_QUERY
  -> Backend validates SQL_QUERY independently
  -> PostgreSQL read-only execution over approved views
  <- Query rows
  -> Backend sanitizes fields and text
  -> AI Gateway /analyze
  -> Groq summarizes sanitized rows
  <- Final MESSAGE
  -> Backend returns final response and structured details
  -> Frontend renders answer cards, metadata, and follow-ups
```

---

## 3. Why the Backend Executes SQL

The Gateway is responsible for language understanding and plan generation. The backend remains responsible for authorization and data access because it already owns:

- User identity and role
- PostgreSQL connectivity
- Approved view definitions
- Query timeout and row-limit policy
- Audit and application logging
- Data sanitization
- The final API contract with the frontend

This separation means the AI provider receives only sanitized data required for the answer.

---

## 4. AI Scopes

The backend maps the current user to one of three read-only scopes:

```text
No authenticated user -> PUBLIC_READ_ONLY
Authenticated user    -> AUTHENTICATED_READ_ONLY
Super Admin           -> SUPERADMIN_READ_ONLY
```

A session is bound to both its scope and the backend identity that created it. A user cannot reuse another user's AI session.

---

## 5. Approved PostgreSQL Views

The backend initializes dedicated AI views rather than permitting base-table access.

### Public scope

```text
ai_public_task_details
ai_public_task_check_history
ai_public_incident_timeline
ai_public_application_logs
ai_public_administrator_contacts
ai_public_host_mappings
```

### Authenticated scope

Public views plus:

```text
ai_authenticated_response_analytics
ai_authenticated_user_activity
```

### Super Admin scope

Authenticated views plus:

```text
ai_superadmin_audit_summary
ai_superadmin_user_accounts
ai_superadmin_archives
ai_superadmin_mail_diagnostics
ai_superadmin_system_health
ai_superadmin_task_configuration
```

The views intentionally omit password hashes, JWTs, session cookies, API keys, service tokens, database passwords, SMTP credentials, authorization headers, private keys, and encryption keys.

---

## 6. Backend AI APIs

Base path:

```text
/api/ai
```

### Status

```http
GET /api/ai/status
```

Example:

```json
{
  "enabled": true,
  "configured": true,
  "available": true,
  "activeSessions": 0,
  "gateway": {
    "ready": true,
    "provider": "groq",
    "model": "llama-3.1-8b-instant"
  }
}
```

### Create session

```http
POST /api/ai/sessions
Content-Type: application/json
```

Response:

```json
{
  "sessionId": "backend-session-uuid",
  "scope": "PUBLIC_READ_ONLY",
  "expiresIn": 3600,
  "requestLimit": 40
}
```

The backend creates its own opaque session ID and stores the separate Gateway session ID only in server memory.

### Send message

```http
POST /api/ai/sessions/:id/messages
Content-Type: application/json

{
  "question": "Give me details of fault application tasks."
}
```

The question must be nonempty and no longer than 4,000 characters.

### Reset session

```http
POST /api/ai/sessions/:id/reset
```

Used by **New chat**. It clears Gateway history and backend-visible conversation context while retaining the frontend's backend session handle when supported.

### Close session

```http
DELETE /api/ai/sessions/:id
```

Used by **Close chat**. It removes the local session and asks the Gateway to delete its corresponding session.

---

## 7. Gateway Planning Request

For each question, the backend calls:

```http
POST /v1/sessions/:gatewaySessionId/messages
Authorization: Bearer <NETWATCH_AI_SERVICE_TOKEN>
Content-Type: application/json

{
  "question": "Summarize the current task status."
}
```

The Gateway may return:

```text
MESSAGE
CLARIFICATION
DENIED
SQL_QUERY
ERROR
```

### Direct message

```json
{
  "type": "MESSAGE",
  "content": "Hello! I can help with approved Netwatch monitoring information."
}
```

### Clarification

```json
{
  "type": "CLARIFICATION",
  "question": "Which task name should I use?"
}
```

### Read-only denial

```json
{
  "type": "DENIED",
  "code": "READ_ONLY_ONLY",
  "content": "Netwatch AI is read-only and cannot perform that action."
}
```

### SQL plan

```json
{
  "type": "SQL_QUERY",
  "query": {
    "sql": "SELECT task_name, status FROM ai_public_task_details WHERE task_type = $1 AND status = $2 ORDER BY task_name LIMIT $3",
    "parameters": [
      "APPLICATION",
      "FAULT",
      25
    ],
    "purpose": "Retrieve faulted application task details",
    "expectedColumns": [
      "task_name",
      "status"
    ]
  },
  "conversationFocus": {
    "taskType": "APPLICATION",
    "status": "FAULT"
  }
}
```

The SQL plan is an intermediate server-to-server object. It is never intentionally returned to the browser.

---

## 8. SQL Plan Normalization

The Gateway normalizes recoverable model variations before sending them to the backend. Examples include:

```text
message -> content
expected_columns -> expectedColumns
conversation_focus -> conversationFocus
query string -> query.sql
numbered parameter object -> ordered parameter array
DATA_REQUEST -> SQL_QUERY
QUESTION -> CLARIFICATION
```

For example, this model output:

```json
{
  "type": "SQL_QUERY",
  "query": "SELECT task_name FROM ai_public_task_details WHERE status = $1 LIMIT $2",
  "parameters": {
    "1": "FAULT",
    "2": 25
  }
}
```

is normalized to:

```json
{
  "type": "SQL_QUERY",
  "query": {
    "sql": "SELECT task_name FROM ai_public_task_details WHERE status = $1 LIMIT $2",
    "parameters": [
      "FAULT",
      25
    ],
    "purpose": "Retrieve approved Netwatch monitoring information.",
    "expectedColumns": []
  }
}
```

The backend still performs its own validation after normalization.

---

## 9. Independent Backend SQL Validation

The backend uses `pgsql-ast-parser` to parse the proposed PostgreSQL query.

Validation requires:

1. A valid plan object.
2. One SQL statement only.
3. A top-level `SELECT` or approved read-only SELECT CTE.
4. No comments or semicolon-separated statements.
5. Relations limited to views approved for the session scope.
6. Referenced columns limited to each approved view's column allowlist.
7. No PostgreSQL catalogs.
8. No dangerous functions.
9. Positional placeholders matching the supplied parameter array.
10. A valid and bounded result limit.

### Rejected examples

```sql
DELETE FROM tasks
```

```sql
SELECT * FROM tasks
```

```sql
SELECT password FROM ai_public_task_details
```

```sql
SELECT pg_read_file($1) FROM ai_public_task_details
```

```sql
SELECT task_name FROM ai_public_task_details;
SELECT email FROM users
```

### Parameter validation

For:

```sql
SELECT task_name
FROM ai_public_task_details
WHERE task_type = $1
  AND status = $2
LIMIT $3
```

the parameters must have exactly three entries:

```json
[
  "APPLICATION",
  "FAULT",
  25
]
```

Missing, skipped, duplicated, or surplus placeholders are rejected.

---

## 10. Row Limits

`AI_SQL_MAX_ROWS` controls the maximum result size, commonly 100 and capped by the implementation.

If the query has no `LIMIT`, the backend wraps it:

```sql
SELECT *
FROM (
  <approved-select>
) AS ai_limited_result
LIMIT 100
```

A parameterized limit greater than the maximum is reduced to the configured maximum. Invalid or negative limit values are rejected.

---

## 11. Read-Only PostgreSQL Execution

Approved SQL executes through the PostgreSQL worker using a dedicated transaction:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SET LOCAL lock_timeout = '1000ms';
<approved SELECT>;
COMMIT;
```

On failure:

```sql
ROLLBACK;
```

Relevant settings:

```dotenv
AI_SQL_TIMEOUT_MS=5000
AI_SQL_LOCK_TIMEOUT_MS=1000
AI_SQL_MAX_ROWS=100
```

The transaction-level safeguards remain effective even if a future plan bypasses an earlier formatting check.

---

## 12. Result Formatting and Sanitization

PostgreSQL returns:

```text
rows
row count
field names
```

The backend constructs a sanitized result:

```json
{
  "purpose": "Retrieve faulted application task details",
  "rowCount": 2,
  "columns": [
    "task_name",
    "status",
    "availability_percent",
    "latest_failure"
  ],
  "rows": [
    {
      "task_name": "ncm-backend",
      "status": "FAULT",
      "availability_percent": 92.4,
      "latest_failure": "Connection timed out"
    }
  ],
  "sanitized": true
}
```

### Field-name removal

Fields matching sensitive concepts are removed recursively, including:

```text
password
hash
JWT
cookie
session token
API key
provider key
service token
SMTP credential
database credential
authorization
secret
private key
encryption key
```

### Text redaction

Text patterns are replaced, including:

```text
gsk_...
Bearer ...
password=...
token=...
secret=...
api_key=...
postgresql://user:password@host
smtp://user:password@host
```

### Date formatting

`Date` values must be converted to ISO strings before generic object traversal:

```javascript
if (value instanceof Date) {
  return Number.isNaN(value.getTime())
    ? null
    : value.toISOString();
}
```

Without this handling, JavaScript dates can become `{}` because they do not expose enumerable fields.

---

## 13. Analysis Request

After query execution and sanitization, the backend calls:

```http
POST /v1/sessions/:gatewaySessionId/analyze
Authorization: Bearer <NETWATCH_AI_SERVICE_TOKEN>
Content-Type: application/json
```

Request:

```json
{
  "question": "Give me details of fault application tasks.",
  "queryResult": {
    "purpose": "Retrieve faulted application task details",
    "rowCount": 2,
    "columns": [
      "task_name",
      "status"
    ],
    "rows": [
      {
        "task_name": "ncm-backend",
        "status": "FAULT"
      }
    ],
    "sanitized": true
  }
}
```

The Gateway sanitizes again, asks Groq to summarize only the supplied result, rejects weak or malformed output, and returns a final `MESSAGE`.

---

## 14. Final Backend Response

Example:

```json
{
  "type": "MESSAGE",
  "content": "Two application tasks are currently in FAULT.",
  "details": [
    {
      "task_name": "ncm-backend",
      "status": "FAULT",
      "availability_percent": 92.4
    }
  ],
  "sanitized": true,
  "dataMeta": {
    "operation": "SQL_QUERY",
    "rowCount": 2,
    "sanitized": true,
    "relations": [
      "ai_public_task_details"
    ]
  }
}
```

The frontend renders `details` as cards and shows:

```text
SQL_QUERY · 2 rows · Sanitized
```

Row metadata is displayed only when `rowCount` is numeric.

---

## 15. Empty Results

A zero-row result is not an error.

Generic response:

```text
No approved records matched your request.
```

More useful deterministic responses can be applied based on the question:

```text
No application tasks are currently in FAULT.
There are currently no open incidents.
No approved check-history records matched the requested filters.
```

The response still includes:

```json
{
  "operation": "SQL_QUERY",
  "rowCount": 0,
  "sanitized": true
}
```

---

## 16. Deterministic Plans for Common Questions

The Gateway can return predefined safe SQL plans for frequent requests instead of relying on the model every time.

Recommended deterministic questions:

```text
Summarize the current task status.
Give me details of fault application tasks.
Summarize open incidents.
```

This prevents a model from mistakenly querying a base table or returning a placeholder such as:

```text
Summarizing current task status...
```

The backend still validates deterministic SQL exactly as it validates model-generated SQL.

---

## 17. Error Handling

| Code | Meaning | Retry guidance |
|---|---|---|
| `AI_DISABLED` | AI feature is disabled | Administrator must enable it |
| `AI_NOT_CONFIGURED` | Gateway URL or service token missing | Correct environment settings |
| `SESSION_EXPIRED` | Temporary session expired | Start New chat |
| `PROVIDER_RATE_LIMIT` | Groq returned HTTP 429 | Wait for `retryAfterSeconds` |
| `PROVIDER_ERROR` | Provider request failed | Inspect Gateway logs |
| `INVALID_STRUCTURED_OUTPUT` | Model output failed normalization/schema | Retry or start New chat |
| `AI_INVALID_SQL` | SQL could not be parsed | Generate a corrected plan |
| `AI_UNSAFE_SQL` | Query violates read-only policy | Do not execute |
| `AI_VIEW_NOT_ALLOWED` | Relation is outside scope | Use approved views |
| `AI_COLUMN_NOT_ALLOWED` | Column is not approved | Select approved columns |
| `AI_PARAMETER_MISMATCH` | Placeholders and parameters differ | Correct parameter array |
| `AI_INVALID_LIMIT` | Limit is invalid or excessive | Use allowed limit |
| `AI_TIMEOUT` | Gateway request timed out | Retry later |

Write requests should receive `READ_ONLY_ONLY`. A failed SQL plan for a legitimate read request should use a query-policy error, not imply that the user requested a write operation.

---

## 18. Authentication Between Backend and Gateway

The shared secret is configured in both components:

```dotenv
NETWATCH_AI_SERVICE_TOKEN=THE_SAME_RANDOM_VALUE
```

Requests use:

```http
Authorization: Bearer <service-token>
```

The token:

- Is never sent to the frontend
- Is never included in AI prompts
- Is never logged in plain text
- Is compared by hash in stack prechecks
- Should be at least 32 random bytes

---

## 19. Docker Networking

```text
Backend and Gateway -> netwatch-ai-network
Backend and Frontend -> netwatch-network
Backend and PostgreSQL -> netwatch-internal
```

Recommended backend aliases:

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

Frontend Nginx uses:

```dotenv
BACKEND_UPSTREAM=http://netwatch-backend:3000
```

Useful tests:

```bash
docker exec netwatch-frontend getent hosts netwatch-backend

docker exec netwatch-frontend \
  wget -qO- http://netwatch-backend:3000/healthz
```

---

## 20. Validation and Deployment

```bash
./validate.sh
./deploy.sh
```

Validation should include:

- JavaScript syntax checks
- Approved SELECT test
- Write-query rejection
- Base-table rejection
- Scope rejection
- Dangerous-function rejection
- Multiple-statement rejection
- Column rejection
- Read-only transaction checks
- Required view checks
- `/analyze` integration check
- Reset and close route checks
- Secret scan

Recommended deployment order:

```text
AI Gateway
Backend
Frontend
New chat
```

---

## 21. Operational Verification

```bash
curl -sS http://127.0.0.1:3000/healthz
curl -sS http://192.168.111.22:8888/api/ai/status
```

Gateway connectivity from backend:

```bash
docker compose exec backend \
  wget -qO- http://independent-ai-gateway:3090/healthz
```

Useful test prompts:

```text
hi
Summarize the current task status.
Give me details of fault application tasks.
Summarize open incidents.
Show URL and target for ncm-backend.
Who are the administrators and what are their contact email addresses?
Show recent sanitized application logs.
Delete all tasks.
```

The final prompt must be denied without executing a write query.

---

## 22. Security Summary

```text
Model proposes; backend decides.
Backend parses; PostgreSQL executes read-only.
Views minimize exposed data.
Scope limits visible views.
Timeouts and limits bound execution.
Sanitizers remove sensitive fields and patterns.
Gateway sanitizes again before provider analysis.
Frontend receives only final answers and approved details.
```
