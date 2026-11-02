# 06 — Database connections & encryption

> Each user owns private PostgreSQL connections; passwords are encrypted with AES-256-GCM using envelope encryption (a per-secret data key wrapped by the key-encrypting key from `CONNECTION_ENCRYPTION_KEY`), tested through a bounded client, and never returned to the browser. A session can reference exactly one of them. Credentials are recoverable if `CONNECTION_ENCRYPTION_KEY` is lost via `CONNECTION_RECOVERY_PASSPHRASE` and the `recovery_keys` table.

**Back to:** [Implementation Walkthrough — Step 3](../history/implementation-walkthrough.md#4-step-3--database-connections-and-encryption) · [Concept index](../history/implementation-walkthrough.md#concept-index)

> **Current implementation note:** connections are multi-engine (`postgres`, `mysql`, `mongodb`). `database_connections` now has `engine`, `connection_uri_encrypted`, and `encryption_key_version`; MongoDB stores an encrypted URI. SQL Server and SQLite are not supported. Encryption uses envelope format `v2` with legacy `v1` support for existing rows. See [Connections API](../reference/api/connections.md), [Recovery API](../reference/api/recovery.md), and [Target databases](../reference/databases/target-databases.md).

## What it is

- **A connection record** stores host, port, database name, username, encrypted password, SSL mode, and a user-facing name.
- **AES-256-GCM** encrypts the password at rest with a key from `CONNECTION_ENCRYPTION_KEY`. It is authenticated encryption: tampering is detected on decrypt.
- **A connection test** opens a short-lived client, verifies reachability, reads the server version, and warns when the supplied role appears to have write privileges.
- **A pool registry** lazily creates a small `pg.Pool` per connection for queries, with idle eviction and invalidation on edit/delete.
- **The session rule:** `conversations.connection_id` is required and immutable after creation.

**Prerequisites:** [03 — Docker, Postgres & environment](03-docker-postgres.md) (env, demo target role). [05 — Auth with bcrypt + JWT](05-auth-jwt.md) (ownership).

## Why this project uses it

- The app's entire value is asking questions about a database the app does not own. That means handling credentials, reachability, and per-user isolation carefully.
- A plaintext password column is a breach waiting to happen. Encryption at rest is the minimum for a multi-user tool.
- Testing a connection before creating a session avoids saving a broken configuration and then failing on the first question.
- One connection per session is an isolation boundary: prompts, table scope, and evidence cannot silently mix two databases.

## When to use this pattern

- Any product where users connect their own data source and the app stores credentials.
- Any multi-tenant tool that needs per-connection pooling and ownership checks.
- For a single trusted internal database, a read-only env connection is simpler; you do not need connection CRUD at all.

## How it works here

### Schema

```sql
CREATE TABLE database_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine text NOT NULL DEFAULT 'postgres'
    CHECK (engine IN ('postgres', 'mysql', 'mongodb')),
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  connection_uri_encrypted text,
  encryption_key_version integer NOT NULL DEFAULT 1,
  ssl_mode text NOT NULL DEFAULT 'prefer'
    CHECK (ssl_mode IN ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX database_connections_owner_idx
  ON database_connections (owner_id, created_at DESC);

CREATE TABLE recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_kek text NOT NULL,
  salt text NOT NULL,
  iterations integer NOT NULL DEFAULT 250000,
  wrap_iv text NOT NULL,
  wrap_tag text NOT NULL,
  recovery_key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
CREATE INDEX recovery_keys_user_idx ON recovery_keys (user_id, created_at DESC);
```

Notes:

- `UNIQUE (owner_id, name)` keeps the UI readable without preventing different users from using the same name.
- `ON DELETE CASCADE` from `users` means deleting an account removes its credentials and its recovery record.
- `password_encrypted` is never selected by list/detail endpoints.
- `encryption_key_version` tracks which version of `CONNECTION_ENCRYPTION_KEY` wrapped the data key for this row; bumped on key rotation.
- `ssl_mode` is stored as a checked string; map it to `pg` SSL options in one place.
- `recovery_keys` stores one wrapped backup of the key-encrypting key per user, wrapped by `CONNECTION_RECOVERY_PASSPHRASE`. Used to recover all credentials if `CONNECTION_ENCRYPTION_KEY` is lost.

### Encryption service

The service uses **envelope encryption**: every secret gets its own random 256-bit data-encryption key (DEK). The plaintext is encrypted with the DEK (AES-256-GCM), and the DEK is wrapped by the key-encrypting key (KEK) derived from `CONNECTION_ENCRYPTION_KEY`. Stored ciphertext:

```
v2:kekVersion:wrapIv:wrapTag:wrappedDek:dataIv:dataTag:data
```

Legacy `v1:` ciphertexts (single-layer, no DEK wrapper) are detected on decrypt and re-encrypted under the envelope format on first use.

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm';
export const KEY_LENGTH = 32;
export const IV_LENGTH = 12;

const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';

function envKey(): Buffer {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) throw new Error('CONNECTION_ENCRYPTION_KEY is required');
  const buffer = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
  if (buffer.length !== KEY_LENGTH) {
    throw new Error('CONNECTION_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buffer;
}

export function getKek(): Buffer {
  return envKey();
}

export function keyVersion(): number {
  const v = Number(process.env.CONNECTION_ENCRYPTION_KEY_VERSION || 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function encryptSecret(plain: string): string {
  const kek = envKey();
  const kekVersion = keyVersion();
  const dek = randomBytes(KEY_LENGTH);
  const dataPlain = Buffer.from(plain, 'utf8');
  const data = encryptWithKey(dataPlain, dek);
  const wrap = wrapDek(dek, kek);
  return [VERSION_V2, String(kekVersion), wrap.iv, wrap.tag, wrap.wrapped, data.iv, data.tag, data.data].join(':');
}

export function decryptSecret(value: string): string {
  if (value.startsWith(`${VERSION_V1}:`)) return decryptLegacy(value);
  if (value.startsWith(`${VERSION_V2}:`)) return decryptV2(value);
  throw new Error('Malformed encrypted secret.');
}

function encryptWithKey(plain: Buffer, key: Buffer) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
}

function wrapDek(dek: Buffer, kek: Buffer) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), wrapped: wrapped.toString('base64') };
}

function decryptV2(value: string): string {
  const parts = value.split(':');
  if (parts.length !== 8 || parts[0] !== VERSION_V2) throw new Error('Malformed encrypted secret.');
  const dek = unwrapDek(parts[4], parts[2], parts[3], envKey());
  return decryptWithKey(parts[7], parts[5], parts[6], dek).toString('utf8');
}

function unwrapDek(wrapped: string, iv: string, tag: string, kek: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const dek = Buffer.concat([decipher.update(Buffer.from(wrapped, 'base64')), decipher.final()]);
  if (dek.length !== KEY_LENGTH) throw new Error('Wrapped data key has invalid length.');
  return dek;
}

function decryptLegacy(value: string): string {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION_V1) throw new Error('Malformed encrypted secret.');
  const decipher = createDecipheriv(ALGORITHM, envKey(), Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

export function reEncryptSecret(value: string): string {
  return encryptSecret(decryptSecret(value));
}

export function isLegacyEncryptedSecret(value: string): boolean {
  return value.startsWith(`${VERSION_V1}:`);
}
```

Why these details:

- **Random 12-byte IV per encryption.** Reusing an IV with GCM is catastrophic. Never derive the IV from the connection id.
- **Auth tag stored with the ciphertext.** A tampered row fails `decipher.final()` instead of decrypting to garbage.
- **Version prefix.** Future key/algorithm changes can support both formats during rotation (`v1` legacy support, `v2` envelope).
- **Key length validation at use.** A misconfigured 16-byte key should fail loudly, not silently weaken encryption.
- **No fallback key.** If the env var is missing, the app should refuse to start or refuse to save a connection. A hardcoded fallback is worse than an outage.
- **Envelope format limits blast radius.** A corrupted DEK wrapper affects only that one secret; the KEK and other DEKs are intact.
- **Key rotation is cheap.** Bump `CONNECTION_ENCRYPTION_KEY_VERSION` and provide the new key; wrapped DEKs are re-wrapped without re-encrypting plaintext.

Generate the key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Recovery passphrase (key loss protection)

`CONNECTION_RECOVERY_PASSPHRASE` wraps a backup copy of the KEK using PBKDF2-HMAC-SHA256 (250k iterations, random salt). The wrapped KEK is stored in `recovery_keys`. If `CONNECTION_ENCRYPTION_KEY` is lost, supply the recovery passphrase to unwrap the KEK backup and decrypt all credentials.

```ts
// Derive recovery key, wrap KEK
const salt = randomBytes(16);
const recoveryKey = pbkdf2Sync(passphrase, salt, 250_000, 32, 'sha256');
// ... AES-256-GCM wrap KEK with recoveryKey ...
```

**Backup both values offline**, separate from the app database and repository. Losing `CONNECTION_ENCRYPTION_KEY` without a recovery record means all stored connection passwords, MongoDB URIs, and provider API keys are unrecoverable.

In production, `CONNECTION_RECOVERY_PASSPHRASE` is required at startup (validated by `validateSecurityConfig()` in `server.ts`).

### Recovery API

| Route | Purpose | Auth |
|---|---|---|
| `GET /api/recovery/status` | Recovery configuration and record status | Auth |
| `POST /api/recovery/setup` | Create a recovery record (wraps KEK backup) | Auth + admin |
| `POST /api/recovery/validate` | Validate a recovery passphrase | Auth |
| `POST /api/recovery/rotate` | Rotate the recovery passphrase | Auth + admin |


### Safe representations

Never return the encrypted value or the decrypted password:

```ts
const SAFE_COLUMNS = `
  id, name, host, port, database_name, username, ssl_mode,
  (password_encrypted IS NOT NULL) AS has_password,
  created_at, updated_at
`;
```

The client sends a password on create and may send a replacement on update. A blank password on update means “keep the existing secret”:

```ts
const passwordEncrypted = password
  ? encryptSecret(password)
  : existing.password_encrypted;
```

Do not echo the password back in an error message. Do not log the request body for connection routes.

### Connection config

```ts
type TargetConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
};

function toPgConfig(config: TargetConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: sslOption(config.sslMode),
    application_name: 'database-knowledge-assistant',
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000)
  };
}

function sslOption(mode: TargetConfig['sslMode']) {
  if (mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}
```

The exact SSL mapping deserves care: `require` in libpq encrypts but does not verify the certificate; `verify-ca`/`verify-full` do. The simple mapping above matches that intent, but production should allow a CA bundle. Document the behavior in the connection form so users know what they are choosing.

### Connection test

Use a short-lived `Client`, not the pooled connection:

```ts
export async function testConnection(config: TargetConfig) {
  const client = new Client(toPgConfig(config));

  try {
    await client.connect();

    const version = await client.query<{ version: string }>('SELECT version()');
    const readOnly = await client.query('SHOW transaction_read_only');
    const role = await client.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user'
    );
    const grants = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables t
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'BASE TABLE'
          AND (
            has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'INSERT')
            OR has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'UPDATE')
            OR has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'DELETE')
          )
      ) AS can_write
    `);

    const roleIsSuperuser = Boolean(role.rows[0]?.rolsuper);
    const canWrite = Boolean(grants.rows[0]?.can_write);

    return {
      ok: true,
      serverVersion: version.rows[0]?.version ?? 'unknown',
      sessionReadOnly: readOnly.rows[0]?.transaction_read_only === 'on',
      roleIsSuperuser,
      warning: roleIsSuperuser
        ? 'This role is a superuser. Use a read-only role for safety.'
        : canWrite
          ? 'This role can write to at least one table. Use a read-only role for safety.'
          : null
    };
  } catch (error: any) {
    return { ok: false, error: safeConnectionError(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
```

`SHOW transaction_read_only` only reflects the session default, not the role's grants. The real write check is grant inspection:

```sql
SELECT table_schema, table_name,
       has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'INSERT') AS can_insert,
       has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'UPDATE') AS can_update,
       has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'DELETE') AS can_delete
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_type = 'BASE TABLE'
LIMIT 50;
```

Return only a boolean warning, not the grant list, unless the UI needs it. The app enforces read-only regardless of the role.

`safeConnectionError` must map known failures to fixed messages (`ECONNREFUSED`, `28P01` bad password, `3D000` missing database, timeout) and must not return `error.message` verbatim; driver errors can contain hostnames, usernames, or connection details.

### Pool registry

Creating a pool per request is wasteful; creating one global pool per user connection can exhaust file descriptors. Use a bounded, lazy registry:

```ts
const pools = new Map<string, { pool: Pool; lastUsed: number }>();
const MAX_POOLS = 20;

export async function getPool(connection: { id: string; updated_at: string }, config: TargetConfig) {
  const cacheKey = `${connection.id}:${connection.updated_at}`;
  const cached = pools.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.pool;
  }

  const pool = new Pool({
    ...toPgConfig(config),
    max: 2,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    options: '-c default_transaction_read_only=on'
  });

  pools.set(cacheKey, { pool, lastUsed: Date.now() });
  evictOldPools(MAX_POOLS);
  return pool;
}
```

- Key by `updated_at` so editing a connection creates a new pool instead of reusing stale credentials.
- `max: 2` is enough for one user asking questions; raise it only with evidence.
- `options: '-c default_transaction_read_only=on'` is a session-level default; the query executor also opens an explicit read-only transaction.
- On delete/update, call `pool.end()` and remove the cache entry.
- Evict least-recently-used pools and `pool.end()` them to avoid leaks.

### API behavior

| Route | Behavior |
|---|---|
| `GET /api/connections` | Owner-scoped list; no secrets |
| `POST /api/connections` | Validate fields, encrypt password, enforce per-user cap |
| `GET /api/connections/:id` | Owner-scoped detail; `has_password` only |
| `PATCH /api/connections/:id` | Update name/host/port/db/user/ssl; optional new password |
| `DELETE /api/connections/:id` | `409` if sessions use it; `?force=true` deletes sessions first |
| `POST /api/connections/:id/test` | `200 { ok, ... }` even on failure, so the UI can show details |
| `GET /api/connections/:id/schema` | Introspection for the session/setup UI |

Validation rules:

- `name` 1–80 characters.
- `host` non-empty; reject whitespace-only.
- `port` integer 1–65535.
- `database_name`, `username` non-empty.
- `ssl_mode` in the allowlist.
- Password required on create, optional on update.
- Per-user cap from `MAX_CONNECTIONS_PER_USER`.

### One connection per session

`conversations.connection_id` is `NOT NULL`, references `database_connections(id) ON DELETE RESTRICT`, and is never patched:

```ts
if (req.body.connectionId !== undefined) {
  return res.status(400).json({
    error: "A session's connection cannot be changed. Start a new session."
  });
}
```

The question route loads the connection from the conversation, never from the request body. This is what makes the isolation boundary real rather than a UI convention.

### Deletion rules

- `DELETE /api/connections/:id` checks for sessions. If any exist, return `409` with the count.
- `?force=true` opens a transaction, deletes the user's sessions for that connection (cascading `qa_history`), then deletes the connection.
- Stop and evict the pool before deleting the row. A pool pointed at a deleted database will fail on the next query; stopping it makes the failure local and obvious.
- Never delete a connection silently when a session still references it.

### SSRF and network exposure

A user-supplied host means the API can be asked to connect to arbitrary network addresses. For an internal tool this may be acceptable, but document it and consider:

- An optional host allowlist or CIDR block list (e.g. `DB_ALLOWED_HOSTS`).
- Block link‑local addresses (`169.254.0.0/16`, `fe80::/10`) and cloud metadata (`169.254.169.254`).
- Block reserved and multicast ranges (`224.0.0.0/4`, `240.0.0.0/4`).
- Block `0.0.0.0`, `100.100.100.200`, `192.0.0.192`.
- Normalise IPv4‑mapped IPv6 addresses (e.g. `::ffff:169.254.169.254`) and reject Unix‑socket paths.
- Block metadata hostnames (`metadata`, `metadata.google.internal`, `instance-data`).
- DNS resolution checks and short connect timeouts.
- A clear warning that connection creation is a privileged operation.

Do not claim SSRF is solved by validating that the host “looks like a hostname.” It is not.

## Pitfalls we hit (and fixes)

1. **Returning `password_encrypted` in a list response.** Easy to do with `SELECT *`. Use an explicit safe column list and assert in tests that the response body does not contain the ciphertext or password.
2. **Reusing an IV.** Generate a fresh 12-byte IV per encryption. A deterministic IV for the same connection id leaks equality and breaks GCM security.
3. **Missing key at boot.** Validate `CONNECTION_ENCRYPTION_KEY` in `server.ts` and fail before accepting requests. A runtime failure on the first connection save is a worse user experience.
4. **Pool leak after edit/delete.** Keying pools by connection id only means an edited connection keeps using old credentials. Key by `id + updated_at`, and explicitly `end()` old pools.
5. **Testing with a superuser.** The demo target must use a non-superuser `demo_reader`. A superuser can bypass grants and makes the read-only demo meaningless.
6. **Logging the connection object.** A structured logger that dumps the whole row includes `password_encrypted`. Redact both `password` and `password_encrypted` at the logger boundary.
7. **Treating a failed test as a 500.** Connection test failure is an expected outcome. Return `200 { ok: false, error }` and let the form show it. Reserve 5xx for the API itself being broken.
8. **Losing `CONNECTION_ENCRYPTION_KEY` without a recovery record.** All stored credentials become unrecoverable. Create a recovery record via `POST /api/recovery/setup` and back up `CONNECTION_RECOVERY_PASSPHRASE` offline.
9. **Rotating `CONNECTION_ENCRYPTION_KEY` without bumping `CONNECTION_ENCRYPTION_KEY_VERSION`.** New ciphertexts are wrapped under the new key but old rows keep the old version; decrypt uses the current env key, so old rows fail to decrypt. Always bump the version on rotation.

## Verification checklist

```bash
# create -> 201, has_password true, no password/ciphertext anywhere
curl -s -X POST localhost:4000/api/connections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Demo","host":"127.0.0.1","port":5435,"database":"demo_analytics","username":"demo_reader","password":"demo_reader_password","sslMode":"disable"}'

# test -> 200 { ok: true } (or ok:false with a safe message)
# another user's id -> 404
# delete with sessions -> 409
# node -e decrypt check: ciphertext != plaintext, decrypt round-trips
npm run test -w apps/backend -- --runInBand -t "connections"

# recovery setup -> 201 { id, user_id, recovery_key_version, created_at }
curl -s -X POST localhost:4000/api/recovery/setup \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{}'

# recovery validate -> 200 { valid: true }
curl -s -X POST localhost:4000/api/recovery/validate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"passphrase":"$RECOVERY_PASSPHRASE"}'
```

## Backlinks

- Walkthrough: [Step 3 — Connections and encryption](../history/implementation-walkthrough.md#4-step-3--database-connections-and-encryption) · [Step 5 — Sessions](../history/implementation-walkthrough.md#6-step-5--sessions-connections-and-table-scoping)
- Related: [07 — Schema introspection & relationships](07-schema-introspection-relationships.md) · [08 — Read-only SQL execution](08-readonly-sql-execution.md) · [13 — Security checklist](13-security-checklist.md)
