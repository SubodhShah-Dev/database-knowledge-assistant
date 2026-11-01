import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getUserModels,
  getAllUserModels,
  getUserModelById,
  createUserModel,
  updateUserModel,
  deleteUserModel,
  type UserModelInput
} from '../services/userModels';

export const userModelsRouter = Router();

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function validateInput(body: any): { error: string } | UserModelInput {
  const label = String(body.label ?? '').trim();
  const modelId = String(body.modelId ?? '').trim();
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey = String(body.apiKey ?? '').trim();
  const isEnabled = body.isEnabled === true || body.is_enabled === true;
  const sortOrder = Number(body.sortOrder ?? body.sort_order ?? 0);

  if (!label || label.length > 100) return { error: 'Name is required (max 100 characters).' };
  if (!modelId || modelId.length > 200) return { error: 'Model identifier is required (max 200 characters).' };
  if (!apiKey) return { error: 'API key is required.' };
  if (apiKey.length > 8192) return { error: 'API key is too long.' };

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
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
    return { error: 'Priority must be a whole number from 0 to 10000.' };
  }
  return { label, modelId, baseUrl, apiKey, isEnabled, sortOrder };
}

userModelsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const models = await getUserModels(req.user!.id);
    res.json(models);
  } catch (error) {
    next(error);
  }
});

userModelsRouter.get('/all', requireAuth, async (req, res, next) => {
  try {
    const models = await getAllUserModels(req.user!.id);
    res.json(models);
  } catch (error) {
    next(error);
  }
});

userModelsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = validateInput(req.body);
    if ('error' in input) return res.status(400).json({ error: input.error });

    const model = await createUserModel(req.user!.id, input);
    res.status(201).json(model);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You already have a provider with that name.' });
    }
    next(error);
  }
});

userModelsRouter.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const input = validateInput(req.body);
    if ('error' in input) return res.status(400).json({ error: input.error });

    const modelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const model = await updateUserModel(req.user!.id, modelId, input);
    if (!model) {
      return res.status(404).json({ error: 'Provider not found.' });
    }
    res.json(model);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You already have a provider with that name.' });
    }
    next(error);
  }
});

userModelsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const modelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await deleteUserModel(req.user!.id, modelId);
    if (!deleted) {
      return res.status(404).json({ error: 'Provider not found.' });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});