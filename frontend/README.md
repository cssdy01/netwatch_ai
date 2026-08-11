# Netwatch Frontend 3.0

Clean deployment package matching Netwatch Backend 3.0 and AI Gateway 3.0.

## AI chat behavior

- Browser calls only same-origin `/api` endpoints through Nginx.
- Backend 3.0 handles Gateway `SQL_QUERY` plans and returns only final answers.
- If an intermediate `SQL_QUERY` reaches the browser, the UI reports a backend compatibility error instead of exposing the SQL.
- Structured `details` are rendered as readable cards.
- Sanitized results show a `Sanitized` marker.
- Row metadata is displayed only when `rowCount` is numeric, preventing empty `· rows` labels.
- `APPLICATION`, `PING`, `FAULT`, `OK`, and task-name filters are retained for relevant follow-ups.
- Follow-up buttons offer details, incident timeline, contacts, URL/target, and check history.
- `INVALID_STRUCTURED_OUTPUT` receives useful recovery guidance.

## Rate-limit experience

For Groq HTTP 429 or `PROVIDER_RATE_LIMIT`:

- The Send button is disabled.
- The button shows `Wait 44s`, for example.
- The banner displays the remaining provider cooldown.
- Repeated clicks do not create repeated cooldown chat messages.
- The typed question remains in the input until it can be sent.
- Input and Send automatically recover after the cooldown.

## Chat controls

```text
+  New chat: reset backend and Gateway context, clear displayed history and filters
■  Close chat: delete backend and Gateway sessions, clear state, hide panel
×  Hide: hide the panel while keeping the current conversation
```

## Existing frontend retained

- Public monitoring dashboard
- Admin login
- Admin dashboard
- Task APIs and controls
- User administration
- Logs and archives
- Backup/import UI integrations
- Existing branding and image asset

## Deploy

The frontend and backend must share `netwatch-network`. The backend container must resolve as `netwatch-backend`, or set `BACKEND_UPSTREAM` to its Docker DNS name.

```bash
chmod 700 validate.sh deploy.sh
./validate.sh

BACKEND_UPSTREAM=http://netwatch-backend:3000 \
FRONTEND_BIND=192.168.111.22 \
FRONTEND_PORT=8888 \
./deploy.sh
```

## Verify

```bash
curl -sS http://192.168.111.22:8888/healthz
curl -sS http://192.168.111.22:8888/api/ai/status
curl -sS http://192.168.111.22:8888/config.js
```

`config.js` must contain an empty `backendUrl`. Browser requests should target `http://192.168.111.22:8888/api/...`, never `localhost:3000`.

After deployment, use Firefox Developer Tools, enable **Disable Cache**, and press `Ctrl+Shift+R` once.

## Recommended deployment sequence

```text
1. AI Gateway 3.0
2. Backend 3.0
3. Frontend 3.0
4. Open the dashboard and select New chat
```
