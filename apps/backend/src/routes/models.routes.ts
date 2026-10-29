import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { encryptSecret } from '../services/connectionCrypto';

export const modelsRouter = Router();

type AdminModelRow = {
  id: string;
  label: string;
  model_id: string;
  base_url: string | null;
  is_enabled: boolean;
  is_default: boolean;
  sort_order: number;
  has_stored_api_key: boolean;
};

function environmentBaseUrl(): string {
  return (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
}

function hasEnvironmentApiKey(baseUrl: string): boolean {
  return Boolean(process.env.LLM_API_KEY) && baseUrl.replace(/\/+$/, '') === environmentBaseUrl();
}

function isLocalEndpoint(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function toAdminModel(row: AdminModelRow) {
  const hasStoredApiKey = row.has_stored_api_key;
  const hasEnvironmentKey =
    Boolean(process.env.LLM_API_KEY) &&
    (row.base_url || environmentBaseUrl()).replace(/\/+$/, '') === environmentBaseUrl();
  const { has_stored_api_key: _hasStoredApiKey, ...model } = row;
  return {
    ...model,
    base_url: row.base_url || environmentBaseUrl(),
    has_api_key: hasStoredApiKey || hasEnvironmentKey,
    api_key_source: hasStoredApiKey ? 'stored' : hasEnvironmentKey ? 'environment' : null
  };
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

function parseModelInput(body: any, requireKey: boolean) {
  const label = String(body.label ?? '').trim();
  const modelId = String(body.modelId ?? body.model_id ?? '').trim();
  const baseUrl = String(body.baseUrl ?? body.base_url ?? '').trim().replace(/\/+$/, '');
  const apiKey = body.apiKey === undefined ? '' : String(body.apiKey).trim();
  const isDefault = body.isDefault === true || body.is_default === true;
  const sortOrder = Number(body.sortOrder ?? body.sort_order ?? 0);

  if (!label || label.length > 100) return { error: 'Name is required (max 100 characters).' };
  if (!modelId || modelId.length > 200) return { error: 'Model identifier is required (max 200 characters).' };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: 'Enter a valid OpenAI-compatible API base URL.' };
  }
  const localEndpoint = isLocalEndpoint(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !localEndpoint)
  ) {
    return { error: 'Use an HTTPS API URL, or HTTP only for a local endpoint.' };
  }
  if (requireKey && !apiKey && !localEndpoint && !hasEnvironmentApiKey(baseUrl)) {
    return { error: 'An API key is required for this endpoint.' };
  }
  if (apiKey.length > 8192) return { error: 'API key is too long.' };
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
    return { error: 'Priority must be a whole number from 0 to 10000.' };
  }
  return { label, modelId, baseUrl, apiKey, isDefault, sortOrder };
}

modelsRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await pool.query<{
      id: string;
      label: string;
      model_id: string;
      is_default: boolean;
    }>(
      `SELECT id, label, model_id, is_default
       FROM models
       WHERE is_enabled = true
       ORDER BY is_default DESC, sort_order, label`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

modelsRouter.get('/admin', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query<AdminModelRow>(
      `SELECT id, label, model_id, base_url, is_enabled, is_default, sort_order,
              api_key_encrypted IS NOT NULL AS has_stored_api_key
       FROM models
       ORDER BY sort_order, label`
    );
    res.json(rows.map(toAdminModel));
  } catch (error) {
    next(error);
  }
});

modelsRouter.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  const input = parseModelInput(req.body, true);
  if ('error' in input) return res.status(400).json({ error: input.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.isDefault) await client.query('UPDATE models SET is_default = false');
    const { rows } = await client.query<AdminModelRow>(
      `INSERT INTO models
         (label, model_id, base_url, api_key_encrypted, is_enabled, is_default, sort_order)
       VALUES ($1, $2, $3, $4, true, $5, $6)
       RETURNING id, label, model_id, base_url, is_enabled, is_default, sort_order,
                 api_key_encrypted IS NOT NULL AS has_stored_api_key`,
      [input.label, input.modelId, input.baseUrl, input.apiKey ? encryptSecret(input.apiKey) : null, input.isDefault, input.sortOrder]
    );
    await client.query('COMMIT');
    res.status(201).json(toAdminModel(rows[0]));
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error.code === '23505') return res.status(409).json({ error: 'That model identifier already exists.' });
    next(error);
  } finally {
    client.release();
  }
});

modelsRouter.put('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  const input = parseModelInput(req.body, false);
  if ('error' in input) return res.status(400).json({ error: input.error });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT api_key_encrypted FROM models WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Model configuration not found.' });
    }
    if (
      !input.apiKey &&
      !existing.rows[0].api_key_encrypted &&
      !isLocalEndpoint(input.baseUrl) &&
      !hasEnvironmentApiKey(input.baseUrl)
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'An API key is required for this endpoint.' });
    }
    if (input.isDefault) {
      await client.query('UPDATE models SET is_default = false WHERE id <> $1', [req.params.id]);
    }
    const { rows } = await client.query<AdminModelRow>(
      `UPDATE models
       SET label = $2, model_id = $3, base_url = $4,
           api_key_encrypted = CASE WHEN $5 <> '' THEN $6 ELSE api_key_encrypted END,
           is_default = $7, sort_order = $8
       WHERE id = $1
       RETURNING id, label, model_id, base_url, is_enabled, is_default, sort_order,
                 api_key_encrypted IS NOT NULL AS has_stored_api_key`,
      [req.params.id, input.label, input.modelId, input.baseUrl, input.apiKey, input.apiKey ? encryptSecret(input.apiKey) : null, input.isDefault, input.sortOrder]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Model configuration not found.' });
    }
    await client.query('COMMIT');
    res.json(toAdminModel(rows[0]));
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error.code === '23505') return res.status(409).json({ error: 'That model identifier already exists.' });
    next(error);
  } finally {
    client.release();
  }
});

modelsRouter.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM models WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Model configuration not found.' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
