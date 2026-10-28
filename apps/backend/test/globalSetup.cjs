const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TEST_DB = process.env.TEST_DB_NAME || 'database_knowledge_assistant_test';
const ADMIN_URL =
  process.env.TEST_ADMIN_URL ||
  'postgres://app_user:local_dev_password@localhost:5434/postgres';
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  `postgres://app_user:local_dev_password@localhost:5434/${TEST_DB}`;

module.exports = async function globalSetup() {
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const db = new Pool({ connectionString: TEST_URL });
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await db.query(schema);
  } finally {
    await db.end();
  }
};
