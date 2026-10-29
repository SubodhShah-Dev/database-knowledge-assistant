import { Client, Pool } from 'pg';
import { assertHostAllowed, createGuardedSocket } from './hostGuard';

export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export type TargetConfig = {
  engine?: 'postgres' | 'mysql' | 'sqlserver' | 'sqlite' | 'mongodb';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
  sqlitePath?: string;
  connectionUri?: string;
};

function sslOption(mode: SslMode) {
  if (mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

function toPgConfig(config: TargetConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: sslOption(config.sslMode),
    application_name: 'database-knowledge-assistant',
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
    stream: createGuardedSocket
  };
}

export function safeConnectionError(error: any): string {
  if (error?.code === 'TARGET_CONFIGURATION') {
    return error.message || 'The database connection configuration is invalid.';
  }
  const code = error?.code ?? error?.cause?.code;
  if (code === 'HOST_BLOCKED') {
    return error?.message || 'This database host is not allowed.';
  }
  if (code === 'HOST_UNRESOLVED' || code === 'ENOTFOUND') return 'The database host could not be found.';
  if (['ECONNREFUSED', 'ESOCKET'].includes(code)) {
    return 'The database refused the connection. Check the host and port.';
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT'].includes(code)) {
    return 'The database connection timed out.';
  }
  if (
    ['28P01', 'ER_ACCESS_DENIED_ERROR', 'ELOGIN', 'AuthenticationFailed'].includes(String(code)) ||
    code === 18
  ) {
    return 'The database rejected the username or password.';
  }
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR') return 'The database does not exist.';
  if (code === '28000') return 'The database rejected this role.';
  if (String(code).startsWith('SQLITE_CANTOPEN')) {
    return 'The SQLite database file could not be opened. Check the path and API file permissions.';
  }
  return 'Could not connect to the database. Check the connection details.';
}

export async function testConnection(config: TargetConfig) {
  try {
    await assertHostAllowed(config.host);
  } catch (error) {
    return { ok: false as const, error: safeConnectionError(error) };
  }

  const client = new Client(toPgConfig(config));

  try {
    await client.connect();

    const version = await client.query<{ version: string }>('SELECT version()');
    const readOnly = await client.query<{ transaction_read_only: string }>(
      'SHOW transaction_read_only'
    );
    const role = await client.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    const grants = await client.query<{ can_write: boolean }>(`
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
      ok: true as const,
      serverVersion: version.rows[0]?.version ?? 'unknown',
      sessionReadOnly: readOnly.rows[0]?.transaction_read_only === 'on',
      roleIsSuperuser,
      warning: roleIsSuperuser
        ? 'This role is a superuser. Use a read-only role for safety.'
        : canWrite
          ? 'This role can write to at least one table. Use a read-only role for safety.'
          : null
    };
  } catch (error) {
    return { ok: false as const, error: safeConnectionError(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const pools = new Map<string, { pool: Pool; lastUsed: number }>();
const MAX_POOLS = 20;

export function getPool(
  connection: { id: string; updated_at: string | Date },
  config: TargetConfig
): Pool {
  const cacheKey = `${connection.id}:${new Date(connection.updated_at).toISOString()}`;
  const cached = pools.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.pool;
  }

  const pool = new Pool({
    ...toPgConfig(config),
    max: 2,
    idleTimeoutMillis: 30_000,
    options: '-c default_transaction_read_only=on'
  });
  pool.on('error', () => undefined);
  pools.set(cacheKey, { pool, lastUsed: Date.now() });

  if (pools.size > MAX_POOLS) {
    const oldest = [...pools.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) {
      pools.delete(oldest[0]);
      void oldest[1].pool.end().catch(() => undefined);
    }
  }

  return pool;
}

export async function invalidatePools(connectionId: string) {
  for (const [key, entry] of pools) {
    if (key.startsWith(`${connectionId}:`)) {
      pools.delete(key);
      await entry.pool.end().catch(() => undefined);
    }
  }
}

export async function closeAllPools() {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map(entry => entry.pool.end().catch(() => undefined)));
}
