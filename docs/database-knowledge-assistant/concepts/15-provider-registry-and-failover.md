# 15 — Provider registry and failover

> Providers are data, not only environment variables. Admins configure them; sessions can pin one; Auto tries the priority chain before streaming starts.

**Back to:** [Concept index](README.md) · [Models API](../../apis/models.md)

## What it is

The `models` table stores OpenAI-compatible provider configurations:

- Label
- Provider model identifier
- Base URL
- Encrypted API key
- Enabled flag
- Default flag
- Priority (`sort_order`)

Environment values (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) remain the fallback when no stored model is available.

## Resolution

`apps/backend/src/services/modelConfig.ts`:

1. If the session has a pinned `model_id`, load that enabled row by UUID or provider model identifier.
2. Otherwise load all enabled rows ordered by default, priority, and label.
3. The first row becomes the primary config.
4. Remaining rows become `fallbacks`.

Stored keys are decrypted. If a row has no stored key and its base URL matches `LLM_BASE_URL`, the environment key is used.

## Failover

`apps/backend/src/services/llm.ts` handles failover before any tokens are emitted:

- Rate limits
- Quota errors
- Timeouts
- Temporary provider failures

Once streaming has started, the request is not retried against another provider, because the client has already received partial output.

## Admin surface

Admins manage providers under **AI providers** (`/admin/models`):

- List all models
- Create
- Update
- Delete
- Set default and priority

The public `GET /api/models` returns only enabled models and never returns keys.

## Validation

- HTTPS required except for localhost/127.0.0.1/::1.
- No URL credentials, query string, or fragment.
- API key required unless local or matching the environment provider.
- One default model.
- `model_id` unique.

## Encryption

Stored keys use the same AES-256-GCM helper as connection secrets:

```text
v1:<iv>:<tag>:<ciphertext>
```

The API returns `has_api_key` and `api_key_source`, never the key.

## Pitfalls

- Changing a provider URL without changing the key can silently point a key at the wrong service.
- A pinned model that is later disabled makes resolution fall back to the environment provider.
- Failover is not a retry of a partially streamed answer.
- The admin UI can create a model without a key only for local endpoints or the environment provider.

## Related docs

- [Models API](../../apis/models.md)
- [Application database](../../databases/application-database.md)
- [LLM provider abstraction](09-llm-provider-abstraction.md)
