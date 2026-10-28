import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { pool } from '../src/db';
import { requireAuth } from '../src/middleware/auth';

const email = `auth-${Date.now()}@example.com`;

afterAll(async () => {
  await pool.end();
});

describe('auth', () => {
  test('signs up and logs in', async () => {
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'Password123!' });

    expect(signup.status).toBe(201);
    expect(signup.body.token).toBeTruthy();
    expect(signup.body.user.email).toBe(email);
    expect(signup.body.user.password_hash).toBeUndefined();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'Password123!' });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
  });

  test('rejects duplicate email', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'Password123!' });
    expect(response.status).toBe(409);
  });

  test('rejects invalid credentials without revealing the account', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid email or password.');
  });

  test('rejects missing and invalid tokens', async () => {
    const probe = express();
    probe.get('/probe', requireAuth, (req, res) => res.json({ userId: req.user?.id }));

    const missing = await request(probe).get('/probe');
    expect(missing.status).toBe(401);

    const bad = await request(probe).get('/probe').set('Authorization', 'Bearer not-a-token');
    expect(bad.status).toBe(401);
  });

  test('accepts a signed token through requireAuth', async () => {
    const probe = express();
    probe.get('/probe', requireAuth, (req, res) => res.json({ userId: req.user?.id }));
    const { rows } = await pool.query('SELECT id, role FROM users WHERE email = $1', [email]);
    const token = jwt.sign(
      { sub: rows[0].id, role: rows[0].role },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' }
    );

    const response = await request(probe)
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.userId).toBe(rows[0].id);
  });
});
