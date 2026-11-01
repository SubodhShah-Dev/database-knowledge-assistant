import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import {
  getUserApiKey,
  setUserApiKey,
  deleteUserApiKey,
  listUserApiKeyModelIds,
  getUserApiKeysWithModels
} from '../services/userApiKeys';

export const userApiKeysRouter = Router();

function requireModelExists(req: Request, res: Response, next: NextFunction) {
  const modelId = req.params.modelId || req.body.modelId;
  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required.' });
  }
  next();
}

userApiKeysRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const modelIds = await listUserApiKeyModelIds(req.user!.id);
    res.json(modelIds);
  } catch (error) {
    next(error);
  }
});

userApiKeysRouter.get('/with-models', requireAuth, async (req, res, next) => {
  try {
    const keys = await getUserApiKeysWithModels(req.user!.id);
    res.json(keys);
  } catch (error) {
    next(error);
  }
});

userApiKeysRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const modelId = String(req.body.modelId || '').trim();
    const apiKey = String(req.body.apiKey || '').trim();

    if (!modelId) return res.status(400).json({ error: 'modelId is required.' });
    if (!apiKey) return res.status(400).json({ error: 'apiKey is required.' });

    const { rows } = await pool.query(
      'SELECT id FROM models WHERE id = $1 AND is_enabled = true',
      [modelId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Model not found or disabled.' });
    }

    await setUserApiKey(req.user!.id, modelId, apiKey);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

userApiKeysRouter.delete('/:modelId', requireAuth, async (req, res, next) => {
  try {
    const modelId = Array.isArray(req.params.modelId) ? req.params.modelId[0] : req.params.modelId;
    const deleted = await deleteUserApiKey(req.user!.id, modelId);
    if (!deleted) {
      return res.status(404).json({ error: 'API key not found for this model.' });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});