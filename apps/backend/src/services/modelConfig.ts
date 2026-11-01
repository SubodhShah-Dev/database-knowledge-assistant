import { pool } from '../db';
import { decryptSecret } from './connectionCrypto';
import { getUserApiKey } from './userApiKeys';
import { getUserModelById, getUserModelByModelId, getUserModels } from './userModels';
import type { LlmConfig } from './llm';

export async function resolveModelConfig({
  modelId,
  userId
}: {
  modelId?: string | null;
  userId?: string;
}): Promise<Partial<LlmConfig> | undefined> {
  if (modelId) {
    if (userId) {
      const userModel = await getUserModelById(userId, modelId) ?? await getUserModelByModelId(userId, modelId);
      if (userModel) {
        return userModelToConfig(userModel);
      }
    }

    const { rows } = await pool.query(
      `SELECT id, model_id, base_url, api_key_encrypted
       FROM models
       WHERE is_enabled = true AND (
         ($1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND id = $1::uuid)
         OR model_id = $1
       )
       LIMIT 1`,
      [modelId]
    );
    if (!rows[0]) return undefined;
    return rowToConfig(rows[0], userId);
  }

  const [userModelsList, adminRows] = await Promise.all([
    userId ? getUserModels(userId) : Promise.resolve([]),
    pool.query(
      `SELECT id, model_id, base_url, api_key_encrypted
       FROM models
       WHERE is_enabled = true
       ORDER BY is_default DESC, sort_order, label`
    )
  ]);

  const adminConfigs = await Promise.all(
    adminRows.rows.map(r => rowToConfig(r, userId))
  );

  const allConfigs: Partial<LlmConfig>[] = [
    ...userModelsList.map(userModelToConfig),
    ...adminConfigs
  ];

  if (!allConfigs[0]) return undefined;
  return {
    ...allConfigs[0],
    fallbacks: allConfigs.slice(1)
  };
}

function userModelToConfig(row: {
  id: string;
  model_id: string;
  base_url: string;
  api_key_encrypted: string;
}): Partial<LlmConfig> {
  const baseUrl = row.base_url.replace(/\/+$/, '');
  return {
    model: row.model_id,
    baseUrl,
    apiKey: decryptSecret(row.api_key_encrypted)
  };
}

async function rowToConfig(row: {
  id: string;
  model_id: string;
  base_url?: string | null;
  api_key_encrypted?: string | null;
}, userId?: string): Promise<Partial<LlmConfig>> {
  const baseUrl = row.base_url?.replace(/\/+$/, '');
  const envBaseUrl = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const effectiveBaseUrl = baseUrl ?? envBaseUrl;

  let apiKey = '';
  if (userId) {
    const userKey = await getUserApiKey(userId, row.id);
    if (userKey) apiKey = userKey;
  }
  if (!apiKey) {
    apiKey = row.api_key_encrypted
      ? decryptSecret(row.api_key_encrypted)
      : effectiveBaseUrl === envBaseUrl ? process.env.LLM_API_KEY || '' : '';
  }

  const config: Partial<LlmConfig> = {
    model: row.model_id,
    apiKey
  };
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}
