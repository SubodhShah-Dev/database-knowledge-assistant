import { pool } from '../db';
import type { LlmConfig } from './llm';

export async function resolveModelConfig({
  modelId
}: {
  modelId?: string | null;
}): Promise<Partial<LlmConfig> | undefined> {
  if (modelId) {
    const { rows } = await pool.query(
      `SELECT model_id, base_url
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
    `SELECT model_id, base_url
     FROM models
     WHERE is_enabled = true AND is_default = true
     LIMIT 1`
  );
  if (!rows[0]) return undefined;
  return rowToConfig(rows[0]);
}

function rowToConfig(row: { model_id: string; base_url?: string | null }): Partial<LlmConfig> {
  const config: Partial<LlmConfig> = { model: row.model_id };
  if (row.base_url) config.baseUrl = row.base_url.replace(/\/+$/, '');
  return config;
}
