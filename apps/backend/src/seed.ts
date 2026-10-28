import bcrypt from 'bcrypt';
import { pool } from './db';

async function seed() {
  const passwordHash = await bcrypt.hash('DemoPassword123!', 12);
  await pool.query(
    `INSERT INTO users(email, password_hash, role) VALUES ($1, $2, 'user')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    ['demo@example.com', passwordHash]
  );

  const adminPasswordHash = await bcrypt.hash('AdminPassword123!', 12);
  await pool.query(
    `INSERT INTO users(email, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    ['admin@example.com', adminPasswordHash]
  );

  await pool.query('UPDATE models SET is_default = false WHERE is_default = true');
  await pool.query(
    `INSERT INTO models(label, model_id, base_url, is_enabled, is_default, sort_order)
     VALUES ($1, $2, $3, true, true, 0)
     ON CONFLICT (model_id) DO UPDATE SET
       label = EXCLUDED.label,
       base_url = EXCLUDED.base_url,
       is_enabled = true,
       is_default = true`,
    [
      process.env.LLM_MODEL || 'openai/gpt-oss-120b',
      process.env.LLM_MODEL || 'openai/gpt-oss-120b',
      process.env.LLM_BASE_URL || null
    ]
  );

  console.log('Seed completed. Demo user, admin user, and default model created.');
  await pool.end();
}

seed().catch(async error => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
