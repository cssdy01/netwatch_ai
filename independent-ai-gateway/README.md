# Independent Netwatch AI Gateway 3.0

The Independent Netwatch AI Gateway is a stateless-to-lightweight conversational planning service placed between the Netwatch backend and Groq. It classifies questions, creates approved read-only PostgreSQL query plans, normalizes structured model output, manages short-lived conversation sessions, analyzes sanitized query results, and enforces an additional content-safety boundary.

The Gateway never connects to PostgreSQL and is not exposed directly to ordinary browser code.

---

## 1. Responsibilities

The Gateway is responsible for:

- Service-token authentication
- Temporary AI conversation sessions
- Scope-aware prompt construction
- Loading and validating application knowledge
- Greeting and help responses
- Immediate secret and write-request denial
- Planning read-only PostgreSQL `SELECT` queries
- Normalizing recoverable model output variations
- Structured-output schema validation
- Optional one-time structured-output repair
- Preliminary SQL safety checks
- Conversation-focus preservation
- Sanitizing query results a second time
- Asking Groq to analyze sanitized data
- Provider timeout, error, and rate-limit handling

The Gateway is not responsible for:

- Database connectivity
- Final SQL authorization
- User authentication or browser cookies
- Monitoring execution
- Task modification
- Sending Netwatch alerts
- Database migrations

---

## 2. Position in the System

```text
Frontend
  -> Backend
       -> AI Gateway
            -> Groq
       <- SQL_QUERY or conversational response
       -> PostgreSQL after independent validation
       -> AI Gateway /analyze with sanitized rows
            -> Groq
       <- final MESSAGE
  <- final response and structured details
```

Only the backend communicates with the Gateway. The frontend uses `/api/ai` on the backend.

---

## 3. Technology

| Component | Technology |
|---|---|
| Runtime | Node.js 20 Alpine |
| HTTP server | Express.js |
| Provider API | Groq OpenAI-compatible Chat Completions |
| Structured validation | Ajv JSON Schema |
| Knowledge file | YAML |
| Deployment | Docker Compose |
| Provider model | Configurable, commonly `llama-3.1-8b-instant` |

---

## 4. Configuration

Typical `.env` settings:

```dotenv
PORT=3090
AI_BIND_ADDRESS=192.168.111.22
AI_HOST_PORT=3090

GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=llama-3.1-8b-instant
GROQ_API_KEY_FILE=/run/secrets/groq_api_key
GROQ_TIMEOUT_MS=30000
MAX_RESPONSE_TOKENS=2000

NETWATCH_AI_SERVICE_TOKEN=CHANGE_ME_TO_A_LONG_RANDOM_VALUE
SESSION_TTL_SECONDS=3600
SESSION_REQUEST_LIMIT=40
SQL_MAX_ROWS=100
```

The Groq key is mounted as a Docker secret:

```text
secrets/groq_api_key -> /run/secrets/groq_api_key
```

The key file should contain only the key, without quotes or trailing carriage returns.

---

## 5. Service Authentication

Every protected Gateway request requires:

```http
Authorization: Bearer <NETWATCH_AI_SERVICE_TOKEN>
```

The same value is configured in the Netwatch backend. The frontend never receives it.

Authentication failures return a controlled 401 or 403 response without exposing the expected token.

---

## 6. Health and Status APIs

### Health

```http
GET /healthz
```

Confirms the process is running.

### Readiness

```http
GET /readyz
```

Confirms knowledge and required provider configuration are available.

### Provider and workflow status

```http
GET /v1/status
Authorization: Bearer <service-token>
```

Example:

```json
{
  "ready": true,
  "provider": "groq",
  "model": "llama-3.1-8b-instant",
  "baseUrl": "https://api.groq.com/openai/v1",
  "providerConfigured": true,
  "workflow": "SQL_QUERY -> backend validation -> PostgreSQL -> sanitized analyze"
}
```

---

## 7. Session APIs

### Create session

```http
POST /v1/sessions
Authorization: Bearer <service-token>
Content-Type: application/json

{
  "scope": "PUBLIC_READ_ONLY"
}
```

Allowed scopes:

```text
PUBLIC_READ_ONLY
AUTHENTICATED_READ_ONLY
SUPERADMIN_READ_ONLY
```

Response:

```json
{
  "sessionId": "gateway-session-uuid",
  "scope": "PUBLIC_READ_ONLY",
  "expiresIn": 3600,
  "requestLimit": 40
}
```

### Send message

```http
POST /v1/sessions/:id/messages
Authorization: Bearer <service-token>
Content-Type: application/json

{
  "question": "Summarize open incidents."
}
```

### Analyze sanitized data

```http
POST /v1/sessions/:id/analyze
Authorization: Bearer <service-token>
Content-Type: application/json

{
  "question": "Summarize open incidents.",
  "queryResult": {
    "purpose": "Summarize open incidents",
    "rowCount": 2,
    "columns": [
      "task_name",
      "status",
      "incident_started_at",
      "latest_failure"
    ],
    "rows": [],
    "sanitized": true
  }
}
```

### Reset session

```http
POST /v1/sessions/:id/reset
```

Clears message history and conversation focus while retaining the session identity and remaining request policy as implemented.

### Delete session

```http
DELETE /v1/sessions/:id
```

Removes the session immediately.

---

## 8. Session State

A Gateway session typically stores:

```text
session ID
scope
created time
last activity
expiration time
request count or remaining limit
recent conversation history
conversation focus
```

Expired sessions are pruned. Requests for missing or expired sessions return a controlled expiration error.

History is intentionally bounded before being sent to Groq, reducing prompt size and limiting accidental retention.

---

## 9. Knowledge File

The Gateway loads application and database knowledge from a YAML file under:

```text
config/knowledge.yaml
```

The knowledge describes:

- Application domain
- Supported monitoring concepts
- Read-only policy
- Scope-specific approved views
- Approved columns and meanings
- Sensitive topics that must never be exposed
- SQL planning constraints
- Conversational guidance

The raw knowledge text is embedded in the provider prompt, while the parsed form is used for local policy checks.

Startup or validation should fail when the knowledge file is missing or malformed.

---

## 10. Request Classification

Before calling Groq, the Gateway applies deterministic checks.

### Greeting

Questions such as:

```text
hi
hello
help
what can you do
```

receive a deterministic `MESSAGE` without provider usage.

### Secret requests

Requests for passwords, hashes, JWTs, cookies, API keys, service tokens, credentials, authorization headers, encryption keys, private keys, or unrestricted raw logs receive:

```json
{
  "type": "DENIED",
  "code": "NEVER_EXPOSE",
  "content": "That information is blocked for every scope."
}
```

### Write or operational actions

Requests to insert, update, delete, drop, alter, create, enable, disable, restore, import, execute, or send mail receive:

```json
{
  "type": "DENIED",
  "code": "READ_ONLY_ONLY",
  "content": "Netwatch AI is read-only and cannot perform that action."
}
```

### Data questions

Questions about current or historical tasks, incidents, checks, availability, status, URLs, targets, contacts, mappings, logs, or diagnostics must produce `SQL_QUERY`.

---

## 11. Deterministic Query Plans

Frequent questions can be handled without model-generated SQL.

Examples:

```text
Summarize the current task status.
Give me details of fault application tasks.
Summarize open incidents.
```

A deterministic plan uses only known approved views and parameterized values. It is still validated by the backend.

Benefits:

- Stable behavior
- Fewer provider calls
- No placeholder responses
- No accidental base-table plans
- Predictable projected fields
- Consistent conversation focus

---

## 12. Provider Planning Prompt

For non-deterministic data questions, the Gateway sends Groq:

1. A system prompt containing schema and safety rules.
2. A bounded slice of sanitized conversation history.
3. The current question.
4. Current conversation focus.
5. Approved scope views.
6. Application knowledge.

The prompt requires exactly one JSON object and prohibits Markdown, code fences, progress messages, and text outside JSON.

The four accepted response types are:

```text
MESSAGE
SQL_QUERY
CLARIFICATION
DENIED
```

---

## 13. Structured Response Contract

### MESSAGE

```json
{
  "type": "MESSAGE",
  "content": "..."
}
```

### CLARIFICATION

```json
{
  "type": "CLARIFICATION",
  "question": "..."
}
```

### DENIED

```json
{
  "type": "DENIED",
  "code": "READ_ONLY_ONLY",
  "content": "..."
}
```

### SQL_QUERY

```json
{
  "type": "SQL_QUERY",
  "query": {
    "sql": "SELECT ...",
    "parameters": [],
    "purpose": "...",
    "expectedColumns": []
  },
  "conversationFocus": {
    "taskType": "APPLICATION",
    "status": "FAULT",
    "taskName": "optional",
    "taskIds": []
  }
}
```

Ajv validates the normalized object against this contract.

---

## 14. Output Normalization

Models sometimes return useful content with a different shape. The Gateway normalizer safely converts known variations.

### Message alias

Input:

```json
{
  "type": "MESSAGE",
  "message": "You're welcome!"
}
```

Normalized:

```json
{
  "type": "MESSAGE",
  "content": "You're welcome!"
}
```

### Flat SQL query

Input:

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

Normalized:

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

Only known aliases are normalized. Unknown or unsafe structures remain invalid.

---

## 15. Structured-Output Repair

If normalization does not produce a schema-valid plan, the Gateway may make one repair request.

The repair prompt contains:

- Original question
- Sanitized previous output
- Validation error text
- The exact required schema instruction
- A reminder that data questions require `SQL_QUERY`

If the repaired object still fails validation, the Gateway returns:

```text
INVALID_STRUCTURED_OUTPUT
```

The raw provider output is never returned to the browser.

---

## 16. Placeholder Detection

A data question must not be answered with progress text such as:

```text
Summarizing current task status...
Checking the database...
Retrieving records...
Please wait...
Let me look that up...
```

These are detected as placeholder messages and trigger repair or rejection.

---

## 17. Preliminary SQL Guard

Before returning `SQL_QUERY`, the Gateway performs a preliminary safety check.

It rejects:

- Writes and DDL
- Multiple statements
- Comments
- `SELECT INTO`
- Catalog access
- Dangerous PostgreSQL functions
- Relations outside approved views

The Gateway guard is deliberately not the final authority. The backend parses the SQL AST and applies stricter view, column, parameter, timeout, and transaction controls.

---

## 18. Conversation Focus

The Gateway can preserve filters such as:

```json
{
  "taskType": "APPLICATION",
  "status": "FAULT",
  "taskName": "ncm-backend",
  "taskIds": []
}
```

This supports follow-up questions such as:

```text
Show details.
Show the incident timeline.
Show notification contacts.
Show URL and target.
Show check history.
```

Focus is reset by New chat and deleted by Close chat.

---

## 19. Analyze Workflow

The backend calls `/analyze` only after SQL has been validated, executed read-only, and sanitized.

```text
Gateway receives sanitized queryResult
  -> sanitizes it again
  -> handles zero-row result deterministically
  -> handles simple count result deterministically
  -> otherwise sends question and sanitized rows to Groq
  -> requires MESSAGE JSON
  -> rejects weak analysis
  -> returns final content plus approved details and metadata
```

### Zero rows

```json
{
  "type": "MESSAGE",
  "content": "No application tasks are currently in FAULT.",
  "details": [],
  "sanitized": true,
  "dataMeta": {
    "operation": "SQL_QUERY",
    "rowCount": 0,
    "sanitized": true
  }
}
```

### Count result

When a count question produces one numeric row, the Gateway can return a deterministic answer without another provider call.

### General result analysis

Groq receives only:

- The original question
- The sanitized result
- Application knowledge needed for interpretation

The model is instructed not to invent facts.

---

## 20. Redaction

The Gateway applies recursive sanitization to provider-bound and provider-returned objects.

Redaction includes:

```text
provider API keys
service tokens
JWTs
cookies
passwords and hashes
authorization headers
database credentials
SMTP credentials
private and encryption keys
credential-bearing URLs
```

Sensitive text is replaced with `[REDACTED]`. Large objects, arrays, and strings are bounded.

---

## 21. Provider Request Handling

The provider module:

1. Reads the Groq key from the secret file.
2. Builds an OpenAI-compatible chat-completion request.
3. Uses the configured model.
4. Requests JSON Object Mode where configured.
5. Applies a request timeout.
6. Parses the returned JSON content.
7. Maps provider failures to controlled Gateway errors.

Typical request body:

```json
{
  "model": "llama-3.1-8b-instant",
  "messages": [],
  "temperature": 0.1,
  "max_completion_tokens": 1600,
  "response_format": {
    "type": "json_object"
  }
}
```

---

## 22. Provider Error Mapping

| Provider condition | Gateway code | Retryable |
|---|---|---|
| HTTP 429 | `PROVIDER_RATE_LIMIT` | Yes |
| HTTP 401/403 | `PROVIDER_AUTHENTICATION_ERROR` | No until configuration changes |
| HTTP 404 model error | `PROVIDER_MODEL_NOT_FOUND` | No until model changes |
| HTTP 5xx | `PROVIDER_UNAVAILABLE` | Yes |
| Request timeout | `PROVIDER_TIMEOUT` | Yes |
| Other invalid request | `PROVIDER_ERROR` | Depends on status |
| Invalid model JSON | `INVALID_STRUCTURED_OUTPUT` | One repair, then controlled failure |

Provider error logs must redact keys and bearer tokens.

---

## 23. Rate-Limit Workflow

When Groq returns 429:

```text
Provider reads Retry-After or rate-limit headers
  -> Gateway returns PROVIDER_RATE_LIMIT
  -> Backend preserves retryAfterSeconds
  -> Frontend disables input and Send
  -> User sees a countdown
  -> No repeated cooldown messages are added
  -> Controls recover automatically
```

---

## 24. Logging and Diagnostics

Useful log events:

```text
[AI PLAN REPAIR]
[AI PLAN VALIDATION FAILED]
[AI PLACEHOLDER MESSAGE REJECTED]
[GROQ ERROR]
```

Logs must contain sanitized output only.

Commands:

```bash
docker compose logs --tail=200 independent-ai-gateway

docker compose logs -f independent-ai-gateway
```

---

## 25. Direct Provider Test

A direct Groq test distinguishes provider configuration problems from Gateway planning problems.

```bash
GROQ_KEY="$(tr -d '\r\n' < secrets/groq_api_key)"

curl -sS \
  https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_KEY" \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"llama-3.1-8b-instant",
    "messages":[
      {"role":"system","content":"Return one JSON object."},
      {"role":"user","content":"Return {\"type\":\"MESSAGE\",\"content\":\"Hello\"}."}
    ],
    "temperature":0.1,
    "max_completion_tokens":200,
    "response_format":{"type":"json_object"}
  }'
```

Never print or commit the key.

---

## 26. Direct Gateway Test

```bash
SERVICE_TOKEN="$(sed -n 's/^NETWATCH_AI_SERVICE_TOKEN=//p' .env | tail -n 1)"

SESSION_ID="$(
  curl -sS \
    -X POST \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H 'Content-Type: application/json' \
    --data '{"scope":"PUBLIC_READ_ONLY"}' \
    http://192.168.111.22:3090/v1/sessions |
  jq -r '.sessionId'
)"

curl -sS \
  -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"question":"Summarize the current task status."}' \
  "http://192.168.111.22:3090/v1/sessions/$SESSION_ID/messages" |
jq .
```

Expected: `SQL_QUERY`, not a final database answer.

---

## 27. Docker Networking

The Gateway and backend share:

```text
netwatch-ai-network
```

Recommended Gateway alias:

```text
independent-ai-gateway
```

Backend setting:

```dotenv
AI_GATEWAY_URL=http://independent-ai-gateway:3090
```

Check resolution from backend:

```bash
docker compose exec backend \
  getent hosts independent-ai-gateway
```

---

## 28. Validation

Gateway validation should verify:

- Required files
- Knowledge YAML schema
- Groq key file presence and permissions
- JavaScript syntax using `node --check`
- No HTML entities such as `&amp;`, `&lt;`, or `&gt;` in source
- SQL guard implementation
- No embedded provider key
- Docker Compose validity
- Shell-script syntax

`node --check` must run before image creation. A text-only validator cannot detect missing JavaScript braces.

---

## 29. Deployment

```bash
chmod 700 validate.sh deploy.sh
./validate.sh
./deploy.sh
```

Equivalent manual commands:

```bash
docker network inspect netwatch-ai-network >/dev/null 2>&1 || \
  docker network create netwatch-ai-network

docker compose build --no-cache independent-ai-gateway

docker compose up -d --force-recreate independent-ai-gateway
```

Validate the image before startup:

```bash
docker run \
  --rm \
  --entrypoint node \
  independent-ai-gateway:3.0.0 \
  --check /app/src/gateway.js
```

---

## 30. Security Model

```text
Browser has no Gateway token.
Gateway has no database credentials.
Groq has no database credentials.
Gateway can propose only read-only plans.
Backend independently parses and authorizes every plan.
PostgreSQL executes inside a read-only transaction.
Only approved AI views are available.
Results are sanitized twice.
Write requests are denied before provider planning.
Provider and session errors are controlled and non-secret.
```

---

## 31. Troubleshooting Matrix

| Symptom | Likely cause | Action |
|---|---|---|
| `PROVIDER_ERROR` | Groq rejected request or provider failed | Inspect sanitized Gateway logs and direct provider test |
| `INVALID_STRUCTURED_OUTPUT` | Model returned wrong object shape | Inspect plan-validation log; verify normalizer and repair |
| Placeholder MESSAGE for data question | Prompt or classifier allowed progress text | Enable placeholder rejection or deterministic plan |
| `VIEW_NOT_APPROVED` | Plan referenced base table or wrong view | Use scope-approved AI view |
| Gateway restart loop | JavaScript syntax error | Run `node --check` before build |
| Backend cannot reach Gateway | Missing Docker network or alias | Check `netwatch-ai-network` and DNS |
| Frontend reports AI unavailable | Backend status cannot reach Gateway | Check `/api/ai/status` and both container logs |
| Date displays as `{}` | Date object traversed generically | Convert Date to ISO before object sanitization |
| 429 countdown | Provider rate limit | Wait for retry interval; do not repeatedly submit |

---

## 32. Workflow Summary

```text
Question received
  -> authenticate backend service token
  -> resolve and validate session
  -> deterministic greeting/denial checks
  -> deterministic plan for common query, when matched
  -> otherwise build scope-aware prompt
  -> call Groq in JSON mode
  -> normalize output
  -> validate schema
  -> repair once if necessary
  -> reject placeholder or unsafe plan
  -> return SQL_QUERY to backend
  -> backend validates and executes read-only
  -> receive sanitized query result through /analyze
  -> sanitize again
  -> zero/count shortcut or Groq analysis
  -> return final MESSAGE
```
