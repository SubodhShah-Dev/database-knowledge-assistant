# Recovery API

Source: `apps/backend/src/routes/recovery.routes.ts`

All routes require authentication. Setup and rotate require `role = 'admin'`.

## Purpose

`CONNECTION_RECOVERY_PASSPHRASE` wraps a backup copy of the key-encrypting key (KEK) derived from `CONNECTION_ENCRYPTION_KEY`. The wrapped KEK is stored in the `recovery_keys` table. If `CONNECTION_ENCRYPTION_KEY` is lost, the recovery passphrase unwraps the KEK backup so all stored connection passwords, MongoDB URIs, and provider API keys can be decrypted.

## Endpoint matrix

| # | Method | Path | Auth | Responsibility |
|---|---|---|---|---|
| 1 | `GET` | `/api/recovery/status` | user | Recovery configuration and record status |
| 2 | `POST` | `/api/recovery/setup` | admin | Create a recovery record wrapping the current KEK |
| 3 | `POST` | `/api/recovery/validate` | user | Validate a recovery passphrase against the stored record |
| 4 | `POST` | `/api/recovery/rotate` | admin | Rotate the recovery passphrase (re-wrap KEK under new passphrase) |

## `GET /api/recovery/status`

Returns recovery configuration and the most recent recovery record (without exposing the wrapped KEK).

Response:

```json
{
  "recovery_passphrase_configured": true,
  "recovery_record_exists": true,
  "recovery_key_version": 1,
  "created_at": "2026-01-01T00:00:00.000Z",
  "rotated_at": null
}
```

## `POST /api/recovery/setup` (admin)

Creates a recovery record for the calling admin user. The current `CONNECTION_ENCRYPTION_KEY` KEK is wrapped by a key derived from `CONNECTION_RECOVERY_PASSPHRASE` (PBKDF2-HMAC-SHA256, 250k iterations, random salt) and stored in `recovery_keys`.

Request body: `{}` (no body required)

Response:

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "recovery_key_version": 1,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

Errors:
- `400` — `CONNECTION_RECOVERY_PASSPHRASE` is not configured.
- `409` — A recovery record already exists for this user.

## `POST /api/recovery/validate`

Validates that a recovery passphrase unlocks the stored wrapped KEK for the calling user. Does not return the KEK.

Request body:

```json
{ "passphrase": "recovery-passphrase-here" }
```

Response:

```json
{ "valid": true }
```

Errors:
- `400` — `passphrase` is required.
- `404` — No recovery record found for this user.

## `POST /api/recovery/rotate` (admin)

Rotates the recovery passphrase: unwraps the KEK with the current passphrase, then re-wraps it under the new passphrase.

Request body:

```json
{ "currentPassphrase": "old-passphrase", "newPassphrase": "new-passphrase-12-chars" }
```

Response:

```json
{ "ok": true }
```

Errors:
- `400` — Missing passphrases or `newPassphrase` shorter than 12 characters.
- `404` — No recovery record for this user.

## Key recovery procedure

If `CONNECTION_ENCRYPTION_KEY` is lost:

1. Set `CONNECTION_RECOVERY_PASSPHRASE` to the backed-up value.
2. Confirm `POST /api/recovery/validate` returns `{ "valid": true }`.
3. Restart the API — `validateSecurityConfig()` in `server.ts` validates the recovery passphrase at boot.
4. The recovered KEK unwraps the DEKs for all stored connection passwords, MongoDB URIs, and provider API keys.

**Prerequisite:** A recovery record must have been created via `POST /api/recovery/setup` before the key was lost, and `CONNECTION_RECOVERY_PASSPHRASE` must be backed up offline. Without both, credentials are unrecoverable.

## Related docs

- [Security checklist](../database-knowledge-assistant/concepts/13-security-checklist.md)
- [Database connections & encryption](../database-knowledge-assistant/concepts/06-database-connections-encryption.md)
