import path from 'node:path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error', error);
});
