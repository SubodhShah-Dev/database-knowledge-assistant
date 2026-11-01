import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  createRecoveryRecord,
  getRecoveryRecord,
  getAnyRecoveryRecord,
  validateRecoveryPassphrase,
  rotateRecoveryPassphrase,
  recoveryPassphraseConfigured,
  getConfiguredRecoveryPassphrase,
  type RecoveryRowInput
} from '../services/keyRecovery';
import { getKek } from '../services/connectionCrypto';

export const recoveryRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

recoveryRouter.get('/status', requireAuth, async (_req, res, next) => {
  try {
    const configured = recoveryPassphraseConfigured();
    const record = await getAnyRecoveryRecord();
    res.json({
      recovery_passphrase_configured: configured,
      recovery_record_exists: Boolean(record),
      recovery_key_version: record?.recovery_key_version ?? null,
      created_at: record?.created_at ?? null,
      rotated_at: record?.rotated_at ?? null
    });
  } catch (error) {
    next(error);
  }
});

recoveryRouter.post('/setup', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!recoveryPassphraseConfigured()) {
      return res.status(400).json({ error: 'CONNECTION_RECOVERY_PASSPHRASE is not configured.' });
    }
    const existing = await getRecoveryRecord(req.user!.id);
    if (existing) {
      return res.status(409).json({ error: 'A recovery record already exists for this user.' });
    }
    const kek = getKek();
    const input: RecoveryRowInput = {
      userId: req.user!.id,
      kek,
      passphrase: getConfiguredRecoveryPassphrase()
    };
    const record = await createRecoveryRecord(input);
    res.status(201).json({
      id: record.id,
      user_id: record.user_id,
      recovery_key_version: record.recovery_key_version,
      created_at: record.created_at
    });
  } catch (error) {
    next(error);
  }
});

recoveryRouter.post('/validate', requireAuth, async (req, res, next) => {
  try {
    const { passphrase } = req.body;
    if (typeof passphrase !== 'string' || !passphrase) {
      return res.status(400).json({ error: 'passphrase is required.' });
    }
    const valid = await validateRecoveryPassphrase(req.user!.id, passphrase);
    res.json({ valid });
  } catch (error) {
    next(error);
  }
});

recoveryRouter.post('/rotate', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { currentPassphrase, newPassphrase } = req.body;
    if (typeof currentPassphrase !== 'string' || !currentPassphrase) {
      return res.status(400).json({ error: 'currentPassphrase is required.' });
    }
    if (typeof newPassphrase !== 'string' || !newPassphrase) {
      return res.status(400).json({ error: 'newPassphrase is required.' });
    }
    if (newPassphrase.length < 12) {
      return res.status(400).json({ error: 'newPassphrase must be at least 12 characters long.' });
    }
    await rotateRecoveryPassphrase(req.user!.id, currentPassphrase, newPassphrase);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
