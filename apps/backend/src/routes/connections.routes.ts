import { Router } from 'express';
import path from 'node:path';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { decryptSecret, encryptSecret } from '../services/connectionCrypto';
import { HostGuardError } from '../services/hostGuard';
import { invalidateSchemaCache } from '../services/introspection';
import {
  getConnectionSchema,
  toTargetConfig,
  type DatabaseEngine,
  type OwnedConnection
} from '../services/connectionAccess';
import {
  safeConnectionError,
  testDatabaseConnection,
  validateConnectionTarget,
  invalidateDatabaseConnection,
  TargetConfigurationError,
  parseMongoUri
} from '../services/databaseAdapters';
import type { SslMode } from '../services/connectionPool';

export const connectionsRouter = Router();

const SAFE_COLUMNS = `
  id, engine, name, host, port, database_name, sqlite_path, username, ssl_mode,
  (password_encrypted IS NOT NULL) AS has_password,
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.connection_id = database_connections.id
  ) AS has_sessions,
  created_at, updated_at
`;

const SSL_MODES: SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
const DATABASE_ENGINES: DatabaseEngine[] = ['postgres', 'mysql', 'sqlserver', 'sqlite', 'mongodb'];

type ConnectionInput = {
  engine: DatabaseEngine;
  name: string;
  host: string;
  port: number;
  database: string;
  sqlitePath: string | null;
  connectionUri: string | null;
  username: string;
  password: string;
  sslMode: SslMode;
};

function parseInput(body: any, existing?: OwnedConnection): ConnectionInput | { error: string } {
  const engine = String(body.engine ?? existing?.engine ?? 'postgres') as DatabaseEngine;
  const name = String(body.name || '').trim();
  let host = String(body.host ?? existing?.host ?? '').trim();
  let port = Number(body.port ?? existing?.port ?? (engine === 'sqlserver' ? 1433 : engine === 'mysql' ? 3306 : 5432));
  let database = String(body.database ?? body.databaseName ?? existing?.database_name ?? '').trim();
  let username = String(body.username ?? body.user ?? existing?.username ?? '').trim();
  const engineChanged = Boolean(existing && engine !== existing.engine);
  const password = body.password === undefined
    ? existing && !engineChanged ? decryptSecret(existing.password_encrypted) : ''
    : String(body.password);
  const sslMode = String(body.sslMode ?? body.ssl_mode ?? existing?.ssl_mode ?? 'prefer') as SslMode;
  let sqlitePath: string | null = null;
  let connectionUri: string | null = null;

  if (!name || name.length > 80) return { error: 'Connection name is required (max 80 characters).' };
  if (!DATABASE_ENGINES.includes(engine)) return { error: 'Unsupported database type.' };

  if (engine === 'sqlite') {
    sqlitePath = String(body.sqlitePath ?? existing?.sqlite_path ?? '').trim();
    if (!sqlitePath || sqlitePath.length > 1024) return { error: 'A SQLite database file path is required.' };
    host = 'local';
    port = 1;
    username = 'local';
    database = database || path.basename(sqlitePath);
  } else if (engine === 'mongodb') {
    const rawUri = body.connectionUri === undefined || body.connectionUri === ''
      ? !engineChanged && existing?.connection_uri_encrypted
        ? decryptSecret(existing.connection_uri_encrypted)
        : ''
      : String(body.connectionUri).trim();
    if (!rawUri || rawUri.length > 4096) return { error: 'A MongoDB connection URI is required.' };
    let uri: ReturnType<typeof parseMongoUri>;
    try {
      uri = parseMongoUri(rawUri);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Enter a valid MongoDB connection URI.' };
    }
    connectionUri = rawUri;
    host = uri.hosts[0].hostname;
    port = uri.hosts[0].port ?? 27017;
    username = uri.username || 'mongodb-user';
    database = database || uri.database;
    if (!database) return { error: 'The MongoDB URI or database field must specify a database.' };
  } else {
    if (!host || host.length > 255) return { error: 'Host is required (max 255 characters).' };
    if (!database || database.length > 63) return { error: 'Database name is required.' };
    if (!username || username.length > 63) return { error: 'Username is required.' };
    if (!password) return { error: 'Password is required.' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be between 1 and 65535.' };
  if (!SSL_MODES.includes(sslMode)) return { error: 'Invalid SSL mode.' };

  return { engine, name, host, port, database, sqlitePath, connectionUri, username, password, sslMode };
}

function targetConfig(input: ConnectionInput) {
  return {
    engine: input.engine,
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    sslMode: input.sslMode,
    sqlitePath: input.sqlitePath ?? undefined,
    connectionUri: input.connectionUri ?? undefined
  };
}

connectionsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS}
       FROM database_connections
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = parseInput(req.body);
    if ('error' in input) return res.status(400).json({ error: input.error });
    await validateConnectionTarget(targetConfig(input));

    const max = Number(process.env.MAX_CONNECTIONS_PER_USER || 20);
    const count = await pool.query(
      'SELECT count(*)::int AS count FROM database_connections WHERE owner_id = $1',
      [req.user!.id]
    );
    if (count.rows[0].count >= max) {
      return res.status(422).json({ error: `You can save at most ${max} connections.` });
    }

    const { rows } = await pool.query(
      `INSERT INTO database_connections
         (owner_id, engine, name, host, port, database_name, sqlite_path,
          connection_uri_encrypted, username, password_encrypted, ssl_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${SAFE_COLUMNS}`,
      [
        req.user!.id,
        input.engine,
        input.name,
        input.host,
        input.port,
        input.database,
        input.sqlitePath,
        input.connectionUri ? encryptSecret(input.connectionUri) : null,
        input.username,
        encryptSecret(input.password),
        input.sslMode
      ]
    );
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error instanceof HostGuardError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error instanceof TargetConfigurationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You already have a connection with that name.' });
    }
    next(error);
  }
});

connectionsRouter.get('/:id/schema', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM database_connections WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Connection not found.' });

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
      const snapshot = await getConnectionSchema(rows[0] as OwnedConnection, refresh);
      res.json({
        connection: { id: rows[0].id, name: rows[0].name, database: rows[0].database_name },
        ...snapshot
      });
    } catch (error) {
      res.status(502).json({ error: safeConnectionError(error) });
    }
  } catch (error) {
    next(error);
  }
});

connectionsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS}
       FROM database_connections
       WHERE id = $1 AND owner_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Connection not found.' });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

connectionsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const existing = await pool.query(
      'SELECT * FROM database_connections WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user!.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Connection not found.' });

    const input = parseInput(req.body, existing.rows[0] as OwnedConnection);
    if ('error' in input) return res.status(400).json({ error: input.error });
    if (input.engine !== (existing.rows[0] as OwnedConnection).engine) {
      const sessions = await pool.query(
        'SELECT count(*)::int AS count FROM conversations WHERE connection_id = $1 AND user_id = $2',
        [req.params.id, req.user!.id]
      );
      if (sessions.rows[0].count > 0) {
        return res.status(409).json({
          error: 'This connection has saved sessions. Delete its sessions before changing the database type.'
        });
      }
    }
    await validateConnectionTarget(targetConfig(input));

    const { rows } = await pool.query(
      `UPDATE database_connections
       SET engine = $3, name = $4, host = $5, port = $6, database_name = $7,
           sqlite_path = $8, connection_uri_encrypted = $9,
           username = $10, password_encrypted = $11, ssl_mode = $12, updated_at = now()
       WHERE id = $1 AND owner_id = $2
       RETURNING ${SAFE_COLUMNS}`,
      [
        req.params.id,
        req.user!.id,
        input.engine,
        input.name,
        input.host,
        input.port,
        input.database,
        input.sqlitePath,
        input.connectionUri ? encryptSecret(input.connectionUri) : null,
        input.username,
        encryptSecret(input.password),
        input.sslMode
      ]
    );
    await invalidateDatabaseConnection(String(req.params.id));
    invalidateSchemaCache(String(req.params.id));
    res.json(rows[0]);
  } catch (error: any) {
    if (error instanceof HostGuardError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error instanceof TargetConfigurationError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You already have a connection with that name.' });
    }
    next(error);
  }
});

connectionsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT id FROM database_connections WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user!.id]
    );
    if (!owned.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Connection not found.' });
    }

    const sessions = await client.query(
      'SELECT count(*)::int AS count FROM conversations WHERE connection_id = $1 AND user_id = $2',
      [req.params.id, req.user!.id]
    );
    if (sessions.rows[0].count > 0 && req.query.force !== 'true') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This connection has sessions. Delete them first or use ?force=true.'
      });
    }

    if (req.query.force === 'true') {
      await client.query('DELETE FROM conversations WHERE connection_id = $1 AND user_id = $2', [
        req.params.id,
        req.user!.id
      ]);
    }
    await client.query('DELETE FROM database_connections WHERE id = $1 AND owner_id = $2', [
      req.params.id,
      req.user!.id
    ]);
    await client.query('COMMIT');
    await invalidateDatabaseConnection(String(req.params.id));
    invalidateSchemaCache(String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

connectionsRouter.post('/:id/test', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM database_connections WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Connection not found.' });
    res.json(await testDatabaseConnection(
      toTargetConfig(rows[0] as OwnedConnection),
      String((rows[0] as OwnedConnection).id)
    ));
  } catch (error) {
    next(error);
  }
});
