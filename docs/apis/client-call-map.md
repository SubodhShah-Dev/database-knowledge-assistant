# Client Call Map

> Reverse index from frontend API wrapper to backend endpoint to UI call site. Line numbers are a snapshot; function and component names are authoritative.

## Auth

| Client function | Endpoint | Call path |
| --- | --- | --- |
| `signIn` | `POST /api/auth/login` | `client.ts:96` → `AuthContext.tsx:28` → `LoginPage.tsx:45` |
| `signUp` | `POST /api/auth/signup` | `client.ts:103` → `AuthContext.tsx:36` → `LoginPage.tsx:46` |

## Connections

| Client function | Endpoint | Call path |
| --- | --- | --- |
| `listConnections` | `GET /api/connections` | `client.ts:110` → `ConnectionsPage.tsx:37`, `NewSessionPage.tsx:45` |
| `createConnection` | `POST /api/connections` | `client.ts:114` → `ConnectionsPage.tsx:54` |
| `updateConnection` | `PATCH /api/connections/:id` | `client.ts:121` → `ConnectionsPage.tsx:52` |
| `deleteConnection` | `DELETE /api/connections/:id` | `client.ts:128` → `ConnectionsPage.tsx:83`, `:92` |
| `testConnection` | `POST /api/connections/:id/test` | `client.ts:134` → `ConnectionsPage.tsx:64` |
| `getSchema` | `GET /api/connections/:id/schema` | `client.ts:138` → `NewSessionPage.tsx:79`, `SessionContextDrawer.tsx:81` |

## Conversations

| Client function | Endpoint | Call path |
| --- | --- | --- |
| `listConversations` | `GET /api/conversations` | `client.ts:144` → `useSessions.ts:41` → `SessionsPage.tsx:18`, `SessionsDrawer.tsx:26` |
| `getConversation` | `GET /api/conversations/:id` | `client.ts:148` → `ChatPage.tsx:144` |
| `createConversation` | `POST /api/conversations` | `client.ts:152` → `NewSessionPage.tsx:124` |
| `updateConversation` | `PATCH /api/conversations/:id` | `client.ts:163` → `useSessions.ts:76` (rename), `ChatPage.tsx:407` (model), `ChatPage.tsx:447` (title), `SessionContextDrawer.tsx:167` (scope) |
| `deleteConversation` | `DELETE /api/conversations/:id` | `client.ts:173` → `useSessions.ts:57` → `SessionsPage.tsx:18`, `SessionsDrawer.tsx:26` |

## Questions

| Client function | Endpoint | Call path |
| --- | --- | --- |
| `streamQuestion` | `POST /api/questions` | `client.ts:211` → `ChatPage.tsx:250` |

## Models

| Client function | Endpoint | Call path |
| --- | --- | --- |
| `listModels` | `GET /api/models` | `client.ts:177` → `NewSessionPage.tsx:45`, `ChatPage.tsx:144` |
| `listAdminModels` | `GET /api/models/admin` | `client.ts:181` → `AdminModelsPage.tsx:43` |
| `createAdminModel` | `POST /api/models` | `client.ts:185` → `AdminModelsPage.tsx:104` |
| `updateAdminModel` | `PUT /api/models/:id` | `client.ts:192` → `AdminModelsPage.tsx:101` |
| `deleteAdminModel` | `DELETE /api/models/:id` | `client.ts:199` → `AdminModelsPage.tsx:120` |

## Implemented but unused by the client

| Endpoint | Notes |
| --- | --- |
| `GET /api/health` | Used by Playwright startup and external health checks |
| `GET /api/connections/:id` | No frontend wrapper; clients can fetch one connection directly |

## Shared client behavior

| Concern | Location |
| --- | --- |
| API base URL | `client.ts:21` (`VITE_API_URL ?? ''`) |
| Token storage | `client.ts:22`, `36-64` |
| Auth header | `client.ts:66-71`, `73-79` |
| 401 handling | `client.ts:85-89` |
| SSE auth and headers | `client.ts:216-225` |
| SSE parser | `client.ts:236-273` |

## UI flow

```text
LoginPage
  -> AuthContext
    -> signIn / signUp

ConnectionsPage
  -> listConnections / createConnection / updateConnection
  -> testConnection / deleteConnection

NewSessionPage
  -> listConnections + listModels
  -> getSchema
  -> createConversation

ChatPage
  -> getConversation + listModels
  -> streamQuestion
  -> updateConversation (model/title)

SessionContextDrawer
  -> getSchema
  -> updateConversation (tables)

SessionsPage / SessionsDrawer
  -> useSessions
    -> listConversations / deleteConversation / updateConversation

AdminModelsPage
  -> listAdminModels / createAdminModel / updateAdminModel / deleteAdminModel
```

## Related docs

- [API index](./README.md)
- [Frontend architecture concept](../database-knowledge-assistant/concepts/11-frontend-architecture.md)
