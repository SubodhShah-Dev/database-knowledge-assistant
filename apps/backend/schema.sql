CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS database_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine text NOT NULL DEFAULT 'postgres'
    CHECK (engine IN ('postgres', 'mysql', 'mongodb')),
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  connection_uri_encrypted text,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1,
  ssl_mode text NOT NULL DEFAULT 'prefer'
    CHECK (ssl_mode IN ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX IF NOT EXISTS database_connections_owner_idx
  ON database_connections (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES database_connections(id) ON DELETE RESTRICT,
  title text NOT NULL,
  selected_tables jsonb NOT NULL DEFAULT '[]',
  model_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_connection_idx
  ON conversations (connection_id);

CREATE TABLE IF NOT EXISTS qa_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  model text,
  answer_mode text CHECK (answer_mode IN ('data', 'schema', 'clarify')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qa_history
  ADD COLUMN IF NOT EXISTS answer_mode text
    CHECK (answer_mode IN ('data', 'schema', 'clarify'));
CREATE INDEX IF NOT EXISTS qa_history_conv_idx
  ON qa_history (conversation_id, id);

DO $$
BEGIN
  -- Delete unsupported connections and their dependents before tightening the CHECK constraint.
  -- qa_history references conversations, conversations have ON DELETE RESTRICT on connection_id.
  -- Delete order: qa_history -> conversations -> database_connections, all in one transaction.
  DELETE FROM qa_history
  WHERE conversation_id IN (
    SELECT id FROM conversations
    WHERE connection_id IN (
      SELECT id FROM database_connections
      WHERE engine IN ('sqlite', 'sqlserver')
    )
  );
  DELETE FROM conversations
  WHERE connection_id IN (
    SELECT id FROM database_connections
    WHERE engine IN ('sqlite', 'sqlserver')
  );
  DELETE FROM database_connections
  WHERE engine IN ('sqlite', 'sqlserver');

  -- Drop sqlite_path if it exists from a previous schema version.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'database_connections' AND column_name = 'sqlite_path'
  ) THEN
    ALTER TABLE database_connections DROP COLUMN sqlite_path;
  END IF;

  -- Replace the engine CHECK constraint to remove sqlite/sqlserver.
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
CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  model_id text NOT NULL UNIQUE,
  base_url text,
  api_key_encrypted text,
  encryption_key_version integer NOT NULL DEFAULT 1,
  is_enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE models ADD COLUMN IF NOT EXISTS api_key_encrypted text;
ALTER TABLE database_connections ADD COLUMN IF NOT EXISTS encryption_key_version integer NOT NULL DEFAULT 1;
ALTER TABLE models ADD COLUMN IF NOT EXISTS encryption_key_version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS models_single_default
  ON models ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS recovery_keys (
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
CREATE INDEX IF NOT EXISTS recovery_keys_user_idx ON recovery_keys (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
