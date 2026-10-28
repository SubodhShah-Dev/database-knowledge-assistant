import request from 'supertest';
import { app } from '../src/app';
import { pool } from '../src/db';
import { resolveModelConfig } from '../src/services/modelConfig';

let token = '';

beforeAll(async () => {
  const email = `models-${Date.now()}@example.com`;
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  token = response.body.token;

  await pool.query('UPDATE models SET is_default = false');
  await pool.query(
    `INSERT INTO models(label, model_id, is_default, sort_order)
     VALUES ('Test Model', 'test-model', true, 1)
     ON CONFLICT (model_id) DO UPDATE SET is_default = true`
  );
});

afterAll(async () => {
  await pool.end();
});

describe('models', () => {
  test('lists enabled models for an authenticated user', async () => {
    const response = await request(app)
      .get('/api/models')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.some((model: any) => model.model_id === 'test-model')).toBe(true);
  });

  test('requires auth', async () => {
    const response = await request(app).get('/api/models');
    expect(response.status).toBe(401);
  });

  test('resolves the default model config without an API key', async () => {
    const config = await resolveModelConfig({});
    expect(config?.model).toBe('test-model');
    expect((config as any)?.apiKey).toBeUndefined();
  });
});
