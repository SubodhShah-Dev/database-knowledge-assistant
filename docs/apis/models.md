# Models and Providers API

Source: `apps/backend/src/routes/models.routes.ts`

Models are OpenAI-compatible provider configurations stored in the app database. API keys are encrypted and never returned.

## `GET /api/models`

Lists enabled models for session selection.

### Response

```json
[
  {
    "id": "uuid",
    "label": "GPT-OSS 120B",
    "model_id": "openai/gpt-oss-120b",
    "is_default": true
  }
]
```

Ordering: default first, then `sort_order`, then label.

Client: `listModels` at `apps/frontend/src/api/client.ts:177`, used by `NewSessionPage.tsx:45` and `ChatPage.tsx:144`.

## `GET /api/models/admin`

Lists all models, including disabled entries and key metadata.

Requires `admin`.

### Response

```json
[
  {
    "id": "uuid",
    "label": "GPT-OSS 120B",
    "model_id": "openai/gpt-oss-120b",
    "base_url": "https://api.groq.com/openai/v1",
    "is_enabled": true,
    "is_default": true,
    "sort_order": 0,
    "has_api_key": true,
    "api_key_source": "stored"
  }
]
```

`api_key_source` is `stored`, `environment`, or `null`.

Client: `listAdminModels` at `client.ts:181`, used by `AdminModelsPage.tsx:43`.

## `POST /api/models`

Creates a model configuration. Requires `admin`.

### Request

```json
{
  "label": "GPT-OSS 120B",
  "modelId": "openai/gpt-oss-120b",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKey": "provider-key",
  "isDefault": true,
  "sortOrder": 0
}
```

### Validation

- `label` required, max 100 characters.
- `modelId` required, max 200 characters.
- `baseUrl` must be a valid URL.
- HTTPS is required except for localhost/127.0.0.1/::1.
- No URL credentials, query string, or fragment.
- An API key is required unless the endpoint is local or matches the environment provider with `LLM_API_KEY`.
- API key max 8192 characters.
- `sortOrder` integer from 0 to 10000.
- Only one default model is allowed.

### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Validation failure |
| `403` | Not an administrator |
| `409` | Duplicate `model_id` |

Client: `createAdminModel` at `client.ts:185`, used by `AdminModelsPage.tsx:104`.

## `PUT /api/models/:id`

Updates a model configuration. Requires `admin`.

### Request

Same fields as create. Omit `apiKey` to keep the stored key.

### Behavior

- Locks the row with `FOR UPDATE`.
- Rejects removal of the only usable key when the endpoint is not local and has no environment key.
- If `isDefault` is true, clears the default flag on other rows.
- Does not change `is_enabled`; the admin UI manages enabled state separately.

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Updated |
| `400` | Validation failure |
| `403` | Not an administrator |
| `404` | Model not found |
| `409` | Duplicate `model_id` |

Client: `updateAdminModel` at `client.ts:192`, used by `AdminModelsPage.tsx:101`.

## `DELETE /api/models/:id`

Deletes a model configuration. Requires `admin`.

- `200` `{ "ok": true }`
- `403` if not an administrator
- `404` if missing

Client: `deleteAdminModel` at `client.ts:199`, used by `AdminModelsPage.tsx:120`.

## Resolution and failover

`apps/backend/src/services/modelConfig.ts` resolves the session model:

- If a model is pinned, load that enabled row by UUID or model identifier.
- Otherwise load all enabled models ordered by default, priority, and label.
- The first model becomes the primary config.
- Remaining models become `fallbacks`.
- Stored keys are decrypted; otherwise the environment key is used when the base URL matches `LLM_BASE_URL`.

`apps/backend/src/services/llm.ts` handles failover before streaming begins. Once tokens have been emitted, the stream is not retried against another provider.

## Related docs

- [API index](./README.md)
- [Application database](../databases/application-database.md)
- [Provider abstraction concept](../database-knowledge-assistant/concepts/09-llm-provider-abstraction.md)
- [Provider and failover concept](../database-knowledge-assistant/concepts/15-provider-registry-and-failover.md)
