import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { decryptSecret, encryptSecret } from '../services/connectionCrypto';
import { getSchemaSnapshot, invalidateSchemaCache } from '../services/introspection';
import { toTargetConfig, type OwnedConnection } from '../services/connectionAccess';
import {
  getPool,
  invalidatePools,
  safeConnectionError,
  testConnection,
  type SslMode
} from '../services/connectionPool';

export const connectionsRouter = Router();

const SAFE_COLUMNS = `
  id, name, host, port, database_name, username, ssl_mode,
  (password_encrypted IS NOT NULL) AS has_password,
  created_at, updated_at
`;

const SSL_MODES: SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

type ConnectionInput = {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
};

function parseInput(body: any, existingPassword?: string): ConnectionInput | { error: string } {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim();
  const port = Number(body.port ?? 5432);
  const database = String(body.database ?? body.databaseName ?? '').trim();
  const username = String(body.username ?? body.user ?? '').trim();
  const password = body.password === undefined ? existingPassword ?? '' : String(body.password);
  const sslMode = String(body.sslMode ?? body.ssl_mode ?? 'prefer') as SslMode;

  if (!name || name.length > 80) return { error: 'Connection name is required (max 80 characters).' };
  if (!host || host.length > 255) return { error: 'Host is required (max 255 characters).' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be between 1 and 65535.' };
  if (!database || database.length > 63) return { error: 'Database name is required.' };
  if (!username || username.length > 63) return { error: 'Username is required.' };
  if (!password) return { error: 'Password is required.' };
  if (!SSL_MODES.includes(sslMode)) return { error: 'Invalid SSL mode.' };

  return { name, host, port, database, username, password, sslMode };
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
         (owner_id, name, host, port, database_name, username, password_encrypted, ssl_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${SAFE_COLUMNS}`,
      [
        req.user!.id,
        input.name,
        input.host,
        input.port,
        input.database,
        input.username,
        encryptSecret(input.password),
        input.sslMode
      ]
    );
    res.status(201).json(rows[0]);
  } catch (error: any) {
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

    const config = toTargetConfig(rows[0] as OwnedConnection);
    const targetPool = getPool(rows[0], config);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
      const snapshot = await getSchemaSnapshot(targetPool, rows[0].id, config, refresh);
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

    const input = parseInput(req.body, decryptSecret(existing.rows[0].password_encrypted));
    if ('error' in input) return res.status(400).json({ error: input.error });

    const { rows } = await pool.query(
      `UPDATE database_connections
       SET name = $3, host = $4, port = $5, database_name = $6,
           username = $7, password_encrypted = $8, ssl_mode = $9, updated_at = now()
       WHERE id = $1 AND owner_id = $2
       RETURNING ${SAFE_COLUMNS}`,
      [
        req.params.id,
        req.user!.id,
        input.name,
        input.host,
        input.port,
        input.database,
        input.username,
        encryptSecret(input.password),
        input.sslMode
      ]
    );
    await invalidatePools(String(req.params.id));
    invalidateSchemaCache(String(req.params.id));
    res.json(rows[0]);
  } catch (error: any) {
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
    await invalidatePools(String(req.params.id));
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
    res.json(await testConnection(toTargetConfig(rows[0] as OwnedConnection)));
  } catch (error) {
    next(error);
  }
});

