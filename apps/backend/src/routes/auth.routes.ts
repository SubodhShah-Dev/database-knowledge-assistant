import { Router, type Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db';

export const authRouter = Router();

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function setTokenCookie(res: Response, token: string): void {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 7200,
    secure: isProduction()
  });
}

function clearTokenCookie(res: Response): void {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: isProduction()
  });
}

function signToken(user: { id: string; role: string }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT secret missing');
  return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: '2h' });
}

function respondWithToken(res: Response, status: number, user: { id: string; email: string; role: string }, token: string) {
  setTokenCookie(res, token);
  return res.status(status).json({ user, token });
}

authRouter.post('/signup', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      return res.status(400).json({
        error: 'Valid email and password of at least 8 characters required.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id, email, role, first_name, last_name',
      [email, passwordHash]
    );

    return respondWithToken(res, 201, rows[0], signToken(rows[0]));
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const { rows } = await pool.query(
      'SELECT id, email, role, password_hash, first_name, last_name FROM users WHERE email = $1',
      [email]
    );

    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const { password_hash: _passwordHash, ...safeUser } = user;
    return respondWithToken(res, 200, safeUser, signToken(safeUser));
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (_req, res) => {
  clearTokenCookie(res);
  return res.json({ ok: true });
});
