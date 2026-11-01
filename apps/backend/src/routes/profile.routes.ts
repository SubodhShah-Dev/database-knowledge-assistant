import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';

export const profileRouter = Router();

function validateName(name: string | undefined): string | null {
  if (!name || name.trim() === '') return null;
  const trimmed = name.trim();
  if (trimmed.length > 50) return 'Name must be 50 characters or less.';
  if (!/^[\p{L}\s'-]+$/u.test(trimmed)) return 'Name can only contain letters, spaces, hyphens, and apostrophes.';
  return trimmed;
}

function isError(result: string | null): result is string {
  return result !== null && result.startsWith('Name');
}

profileRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, first_name, last_name FROM users WHERE id = $1',
      [req.user!.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

profileRouter.put('/', requireAuth, async (req, res, next) => {
  try {
    const first_name = validateName(req.body.first_name);
    if (isError(first_name)) {
      return res.status(400).json({ error: first_name });
    }
    const last_name = validateName(req.body.last_name);
    if (isError(last_name)) {
      return res.status(400).json({ error: last_name });
    }

    const { rows } = await pool.query(
      `UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1 RETURNING id, email, role, first_name, last_name`,
      [req.user!.id, first_name, last_name]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

profileRouter.put('/password', requireAuth, async (req, res, next) => {
  try {
    const current_password = String(req.body.current_password || '');
    const new_password = String(req.body.new_password || '');
    const confirm_password = String(req.body.confirm_password || '');

    if (!current_password) return res.status(400).json({ error: 'Current password is required.' });
    if (!new_password) return res.status(400).json({ error: 'New password is required.' });
    if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    if (new_password !== confirm_password) return res.status(400).json({ error: 'New passwords do not match.' });

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user!.id]);

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});