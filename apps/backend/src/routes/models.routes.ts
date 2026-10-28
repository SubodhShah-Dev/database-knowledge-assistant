import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';

export const modelsRouter = Router();

modelsRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
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
