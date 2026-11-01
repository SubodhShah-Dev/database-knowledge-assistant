import { pool } from '../db';
import { encryptSecret, decryptSecret, currentKeyVersion } from './connectionCrypto';

export type UserApiKeyRow = {
  id: string;
  user_id: string;
  model_id: string;
  api_key_encrypted: string;
  encryption_key_version: number;
  created_at: string;
  updated_at: string;
};

export async function getUserApiKey(userId: string, modelId: string): Promise<string | null> {
  const { rows } = await pool.query<UserApiKeyRow>(
    `SELECT api_key_encrypted FROM user_api_keys WHERE user_id = $1 AND model_id = $2`,
    [userId, modelId]
  );
  if (!rows[0]) return null;
  return decryptSecret(rows[0].api_key_encrypted);
}

export async function setUserApiKey(userId: string, modelId: string, apiKey: string): Promise<void> {
  const keyVer = currentKeyVersion();
  const encrypted = encryptSecret(apiKey);
  await pool.query(
    `INSERT INTO user_api_keys (user_id, model_id, api_key_encrypted, encryption_key_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, model_id) DO UPDATE SET
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       encryption_key_version = EXCLUDED.encryption_key_version,
       updated_at = now()`,
    [userId, modelId, encrypted, keyVer]
  );
}

export async function deleteUserApiKey(userId: string, modelId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM user_api_keys WHERE user_id = $1 AND model_id = $2`,
    [userId, modelId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listUserApiKeyModelIds(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ model_id: string }>(
    `SELECT model_id FROM user_api_keys WHERE user_id = $1`,
    [userId]
  );
  return rows.map(r => r.model_id);
}

export async function getUserApiKeysWithModels(userId: string): Promise<Array<{
  modelId: string;
  label: string;
  model_id: string;
  base_url: string;
  hasKey: boolean;
}>> {
  const { rows } = await pool.query(
    `SELECT m.id as modelId, m.label, m.model_id, m.base_url,
            u.api_key_encrypted IS NOT NULL as hasKey
     FROM models m
     LEFT JOIN user_api_keys u ON u.model_id = m.id AND u.user_id = $1
     WHERE m.is_enabled = true
     ORDER BY m.is_default DESC, m.sort_order, m.label`,
    [userId]
  );
  return rows.map(r => ({
    modelId: r.modelid,
    label: r.label,
    model_id: r.model_id,
    base_url: r.base_url,
    hasKey: r.haskey
  }));
}