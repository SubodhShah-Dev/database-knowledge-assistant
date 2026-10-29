import { pool } from '../db';
import { decryptSecret } from './connectionCrypto';
import type { LlmConfig } from './llm';

export async function resolveModelConfig({
  modelId
}: {
  modelId?: string | null;
}): Promise<Partial<LlmConfig> | undefined> {
  if (modelId) {
    const { rows } = await pool.query(
      `SELECT model_id, base_url, api_key_encrypted
       FROM models
       WHERE is_enabled = true AND (
         ($1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND id = $1::uuid)
         OR model_id = $1
       )
       LIMIT 1`,
      [modelId]
    );
    if (!rows[0]) return undefined;
    return rowToConfig(rows[0]);
  }

  const { rows } = await pool.query(
    `SELECT model_id, base_url, api_key_encrypted
     FROM models
     WHERE is_enabled = true
     ORDER BY is_default DESC, sort_order, label`
  );
  if (!rows[0]) return undefined;
  const configs = rows.map(rowToConfig);
  return {
    ...configs[0],
    fallbacks: configs.slice(1)
  };
}

function rowToConfig(row: {
  model_id: string;
  base_url?: string | null;
  api_key_encrypted?: string | null;
}): Partial<LlmConfig> {
  const baseUrl = row.base_url?.replace(/\/+$/, '');
  const envBaseUrl = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const effectiveBaseUrl = baseUrl ?? envBaseUrl;
  const config: Partial<LlmConfig> = {
    model: row.model_id,
    apiKey: row.api_key_encrypted
      ? decryptSecret(row.api_key_encrypted)
      : effectiveBaseUrl === envBaseUrl ? process.env.LLM_API_KEY || '' : ''
  };
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}
