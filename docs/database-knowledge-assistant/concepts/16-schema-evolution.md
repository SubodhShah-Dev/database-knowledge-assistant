# 16 — Schema evolution and legacy cleanup

> `schema.sql` is both the initial schema and the upgrade path. It is idempotent, additive, and includes guarded cleanup for engines the app no longer supports.

**Back to:** [Concept index](README.md) · [Schema reference](../../databases/schema-reference.md)

## What it is

The project does not use a migration framework. Instead:

- `apps/backend/schema.sql` is the source of truth.
- `npm run db:setup` applies it to the app database and then seeds.
- Jest applies the same file to a throwaway test database.
- Existing deployments rerun the file to pick up new columns and constraints.

## Evolution patterns used

### Additive tables

```sql
CREATE TABLE IF NOT EXISTS models (...);
```

### Additive columns

```sql
ALTER TABLE qa_history
  ADD COLUMN IF NOT EXISTS answer_mode text
    CHECK (answer_mode IN ('data', 'schema', 'clarify'));

ALTER TABLE models ADD COLUMN IF NOT EXISTS api_key_encrypted text;
```

### Guarded constraint replacement

The engine check is replaced only if the old constraint exists:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'database_connections'::regclass
      AND conname = 'database_connections_engine_check'
  ) THEN
    ALTER TABLE database_connections DROP CONSTRAINT database_connections_engine_check;
  END IF;

  ALTER TABLE database_connections
    ADD CONSTRAINT database_connections_engine_check
    CHECK (engine IN ('postgres', 'mysql', 'mongodb'));
END
$$;
```

### Legacy cleanup

The `DO` block:

- Deletes `qa_history` for sessions attached to SQLite/SQL Server connections.
- Deletes those sessions.
- Deletes those connections.
- Drops `sqlite_path` if it exists.
- Replaces the engine constraint.

This is why `schema.sql` still mentions SQLite/SQL Server even though they are unsupported.

## Why no migration framework

- The project is a small internal tool.
- The schema is applied identically in dev and tests.
- The file is readable and reviewable.
- There is no migration ordering or checksum table to maintain.

The trade-off: destructive changes must be written carefully, and large production upgrades may eventually need a real migration tool.

## Current schema additions

| Change | Table |
| --- | --- |
| `engine` | `database_connections` |
| `connection_uri_encrypted` | `database_connections` |
| `encryption_key_version` | `database_connections` |
| `encryption_key_version` | `models` |
| `answer_mode` | `qa_history` |
| `api_key_encrypted` | `models` |
| `models_single_default` partial unique index | `models` |
| `recovery_keys` table (user_id, wrapped_kek, salt, iterations, wrap_iv, wrap_tag, recovery_key_version, created_at, rotated_at) | new table |
| `recovery_keys_user_idx` index | `recovery_keys` |

## Verification

```bash
npm run db:setup
npm test
```

Check the resulting schema:

```bash
psql "$DATABASE_URL" -c '\d database_connections'
psql "$DATABASE_URL" -c '\d qa_history'
psql "$DATABASE_URL" -c '\d models'
```

## Related docs

- [Application database](../../databases/application-database.md)
- [Schema reference](../../databases/schema-reference.md)
- [Setup, seed, and E2E lifecycle](17-setup-seed-e2e.md)
