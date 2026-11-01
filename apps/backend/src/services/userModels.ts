import { pool } from '../db';
import { encryptSecret, decryptSecret, currentKeyVersion } from './connectionCrypto';

export type UserModelRow = {
  id: string;
  user_id: string;
  label: string;
  model_id: string;
  base_url: string;
  api_key_encrypted: string;
  encryption_key_version: number;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type UserModelInput = {
  label: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
  sortOrder: number;
};

export async function getUserModels(userId: string): Promise<UserModelRow[]> {
  const { rows } = await pool.query<UserModelRow>(
    `SELECT * FROM user_models WHERE user_id = $1 AND is_enabled = true ORDER BY sort_order, label`,
    [userId]
  );
  return rows;
}

export async function getAllUserModels(userId: string): Promise<UserModelRow[]> {
  const { rows } = await pool.query<UserModelRow>(
    `SELECT * FROM user_models WHERE user_id = $1 ORDER BY sort_order, label`,
    [userId]
  );
  return rows;
}

export async function getUserModelById(userId: string, modelId: string): Promise<UserModelRow | null> {
  const { rows } = await pool.query<UserModelRow>(
    `SELECT * FROM user_models WHERE user_id = $1 AND id = $2`,
    [userId, modelId]
  );
  return rows[0] ?? null;
}

export async function getUserModelByModelId(userId: string, modelId: string): Promise<UserModelRow | null> {
  const { rows } = await pool.query<UserModelRow>(
    `SELECT * FROM user_models WHERE user_id = $1 AND model_id = $2`,
    [userId, modelId]
  );
  return rows[0] ?? null;
}

export async function createUserModel(userId: string, input: UserModelInput): Promise<UserModelRow> {
  const keyVer = currentKeyVersion();
  const encrypted = encryptSecret(input.apiKey);
  const { rows } = await pool.query<UserModelRow>(
    `INSERT INTO user_models (user_id, label, model_id, base_url, api_key_encrypted, encryption_key_version, is_enabled, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, input.label, input.modelId, input.baseUrl, encrypted, keyVer, input.isEnabled, input.sortOrder]
  );
  return rows[0];
}

export async function updateUserModel(userId: string, modelId: string, input: UserModelInput): Promise<UserModelRow | null> {
  const keyVer = currentKeyVersion();
  const encrypted = encryptSecret(input.apiKey);
  const { rows } = await pool.query<UserModelRow>(
    `UPDATE user_models
     SET label = $3, model_id = $4, base_url = $5,
         api_key_encrypted = $6, encryption_key_version = $7,
         is_enabled = $8, sort_order = $9, updated_at = now()
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [userId, modelId, input.label, input.modelId, input.baseUrl, encrypted, keyVer, input.isEnabled, input.sortOrder]
  );
  return rows[0] ?? null;
}

export async function deleteUserModel(userId: string, modelId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM user_models WHERE user_id = $1 AND id = $2`,
    [userId, modelId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getUserModelApiKey(userId: string, modelId: string): Promise<string | null> {
  const model = await getUserModelById(userId, modelId);
  if (!model) return null;
  return decryptSecret(model.api_key_encrypted);
}