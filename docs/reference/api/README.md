# API Reference

> Complete HTTP surface of the Database Knowledge Assistant. Every endpoint below is implemented in `apps/backend/src/routes/` and called through `apps/frontend/src/api/client.ts` unless noted otherwise.

## Conventions

| Item | Value |
| --- | --- |
| Base URL | `VITE_API_URL` or same-origin `/api` through the Vite proxy |
| Auth | `Authorization: Bearer <jwt>` or `token` HttpOnly cookie (set on signup/login; `credentials: 'include'` on fetches) |
| Content type | `application/json` for normal requests |
| Auth token lifetime | 2 hours |
| 401 behavior | Client clears the token and redirects to `/login` |
| Ownership | Users can only read or mutate their own connections, sessions, and history |
| Other users' resources | Return `404`, not `403`, to avoid leaking existence |
| Admin routes | Require `role = 'admin'`; otherwise `403` |

Errors use:

```json
{ "error": "Human-readable message." }
```

Some validation errors also include the rejected query:

```json
{ "error": "Only read-only SELECT statements are allowed.", "sql": "DELETE FROM orders" }
```

## Endpoint matrix

| # | Method | Path | Auth | Responsibility | Client wrapper |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET` | `/api/health` | none | Liveness check | — |
| 2 | `POST` | `/api/auth/signup` | none | Create a user and return a JWT | `signUp` |
| 3 | `POST` | `/api/auth/login` | none | Verify credentials and return a JWT | `signIn` |
| 4 | `GET` | `/api/connections` | user | List owned connections | `listConnections` |
| 5 | `POST` | `/api/connections` | user | Validate, encrypt, and create a connection | `createConnection` |
| 6 | `GET` | `/api/connections/:id` | user | Read one owned connection | — |
| 7 | `PATCH` | `/api/connections/:id` | user | Update a connection; optionally replace secrets | `updateConnection` |
| 8 | `DELETE` | `/api/connections/:id` | user | Delete a connection; `?force=true` cascades sessions | `deleteConnection` |
| 9 | `POST` | `/api/connections/:id/test` | user | Test target connectivity and read-only posture | `testConnection` |
| 10 | `GET` | `/api/connections/:id/schema` | user | Read or refresh the target schema snapshot | `getSchema` |
| 11 | `GET` | `/api/conversations` | user | List owned sessions | `listConversations` |
| 12 | `POST` | `/api/conversations` | user | Create a session bound to one connection | `createConversation` |
| 13 | `GET` | `/api/conversations/:id` | user | Read session detail and history turns | `getConversation` |
| 14 | `PATCH` | `/api/conversations/:id` | user | Update title, table scope, or model | `updateConversation` |
| 15 | `DELETE` | `/api/conversations/:id` | user | Delete a session and its history | `deleteConversation` |
| 16 | `POST` | `/api/questions` | user | Plan, validate, execute, and stream an answer (SSE) | `streamQuestion` |
| 17 | `GET` | `/api/models` | user | List enabled models | `listModels` |
| 18 | `GET` | `/api/models/admin` | admin | List all model configurations | `listAdminModels` |
| 19 | `POST` | `/api/models` | admin | Create a model/provider configuration | `createAdminModel` |
| 20 | `PUT` | `/api/models/:id` | admin | Update a model/provider configuration | `updateAdminModel` |
| 21 | `DELETE` | `/api/models/:id` | admin | Delete a model configuration | `deleteAdminModel` |
| 22 | `GET` | `/api/recovery/status` | user | Recovery configuration and record status | — |
| 23 | `POST` | `/api/recovery/setup` | admin | Create a recovery record wrapping the KEK | — |
| 24 | `POST` | `/api/recovery/validate` | user | Validate a recovery passphrase | — |
| 25 | `POST` | `/api/recovery/rotate` | admin | Rotate the recovery passphrase | — |

Implemented but unused by the frontend:

- `GET /api/health` — useful for health checks and Playwright startup.
- `GET /api/connections/:id` — available for clients that need one connection.

## SSE contract

`POST /api/questions` always responds with `text/event-stream` once validation passes.

```text
event: status
data: {"phase":"planning","label":"Understanding the question"}

event: evidence
data: {"evidence":{...}}

event: token
data: {"text":"partial answer"}

event: done
data: {"conversationId":1,"messageId":42,"answer":"...","model":"...","mode":"data"}
```

Error event:

```text
event: error
data: {"error":"...","code":"timeout","sql":"SELECT ..."}
```

Pre-stream failures return normal JSON with a non-2xx status.

## Resource docs

- [Auth](./auth.md)
- [Connections](./connections.md)
- [Conversations](./conversations.md)
- [Questions and SSE](./questions.md)
- [Models and providers](./models.md)
- [Recovery](./recovery.md)
- [Client call map](./client-call-map.md)

## Related docs

- [Current state](../../architecture/current-state.md)
- [Database reference](../databases/README.md)
