import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { pool } from '../src/db';
import { decryptSecret } from '../src/services/connectionCrypto';
import { resolveModelConfig } from '../src/services/modelConfig';

let token = '';
let adminToken = '';

beforeAll(async () => {
  const email = `models-${Date.now()}@example.com`;
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  token = response.body.token;
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [response.body.user.id]);
  adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET!, {
    subject: response.body.user.id
  });

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

  test('restricts provider configuration to administrators', async () => {
    const response = await request(app)
      .get('/api/models/admin')
      .set('Authorization', 'Bearer ' + token);
    expect(response.status).toBe(403);
  });

  test('validates, encrypts, masks, updates, and deletes provider API keys', async () => {
    const invalid = await request(app)
      .post('/api/models')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        label: 'Invalid endpoint',
        modelId: `invalid-${Date.now()}`,
        baseUrl: 'http://api.example.test/v1',
        apiKey: 'not-a-real-key'
      });
    expect(invalid.status).toBe(400);

    const localModel = await request(app)
      .post('/api/models')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        label: 'Local test provider',
        modelId: `local-test-${Date.now()}`,
        baseUrl: 'http://localhost:1234/v1',
        sortOrder: 49
      });
    expect(localModel.status).toBe(201);
    try {
      const remoteUpdate = await request(app)
        .put(`/api/models/${localModel.body.id}`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          label: 'Local test provider',
          modelId: localModel.body.model_id,
          baseUrl: 'https://api.example.test/v1',
          sortOrder: 49
        });
      expect(remoteUpdate.status).toBe(400);
    } finally {
      await pool.query('DELETE FROM models WHERE id = $1', [localModel.body.id]);
    }

    const environmentModel = await request(app)
      .post('/api/models')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        label: 'Environment-key test provider',
        modelId: `environment-test-${Date.now()}`,
        baseUrl: process.env.LLM_BASE_URL,
        sortOrder: 48
      });
    expect(environmentModel.status).toBe(201);
    expect(environmentModel.body.api_key_source).toBe('environment');
    try {
      const updatedEnvironmentModel = await request(app)
        .put(`/api/models/${environmentModel.body.id}`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          label: 'Updated environment-key test provider',
          modelId: environmentModel.body.model_id,
          baseUrl: process.env.LLM_BASE_URL,
          sortOrder: 48
        });
      expect(updatedEnvironmentModel.status).toBe(200);
      expect(updatedEnvironmentModel.body.api_key_source).toBe('environment');

      const listed = await request(app)
        .get('/api/models/admin')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(
        listed.body.find((model: any) => model.id === environmentModel.body.id).api_key_source
      ).toBe('environment');
    } finally {
      await pool.query('DELETE FROM models WHERE id = $1', [environmentModel.body.id]);
    }

    const modelId = `admin-test-${Date.now()}`;
    const apiKey = 'test-secret-not-a-real-provider-key';
    const created = await request(app)
      .post('/api/models')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        label: 'Admin test provider',
        modelId,
        baseUrl: 'https://api.example.test/v1',
        apiKey,
        sortOrder: 50
      });

    expect(created.status).toBe(201);
    expect(created.body.has_api_key).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain(apiKey);

    try {
      const { rows } = await pool.query(
        'SELECT api_key_encrypted FROM models WHERE id = $1',
        [created.body.id]
      );
      expect(rows[0].api_key_encrypted).not.toBe(apiKey);
      expect(decryptSecret(rows[0].api_key_encrypted)).toBe(apiKey);

      const listed = await request(app)
        .get('/api/models/admin')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(listed.status).toBe(200);
      const item = listed.body.find((model: any) => model.id === created.body.id);
      expect(item.has_api_key).toBe(true);
      expect(JSON.stringify(item)).not.toContain(apiKey);

      const updated = await request(app)
        .put(`/api/models/${created.body.id}`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          label: 'Updated test provider',
          modelId,
          baseUrl: 'https://api.example.test/v1',
          apiKey: '',
          sortOrder: 50
        });
      expect(updated.status).toBe(200);
      expect(updated.body.has_api_key).toBe(true);

      const removed = await request(app)
        .delete(`/api/models/${created.body.id}`)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(removed.status).toBe(200);
    } finally {
      await pool.query('DELETE FROM models WHERE id = $1', [created.body.id]);
    }
  });

  test('resolves the default model config using the environment provider settings', async () => {
    const config = await resolveModelConfig({});
    expect(config?.model).toBe('test-model');
    expect(config?.apiKey).toBe(process.env.LLM_API_KEY || '');
  });
});
