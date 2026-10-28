process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://app_user:local_dev_password@localhost:5434/database_knowledge_assistant_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-1234';
process.env.CONNECTION_ENCRYPTION_KEY =
  process.env.CONNECTION_ENCRYPTION_KEY || 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://llm.invalid/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';
process.env.SQL_MAX_ROWS = '100';
process.env.SQL_TIMEOUT_MS = '5000';
process.env.SQL_SCHEMA_CACHE_MS = '300000';
process.env.DB_CONNECT_TIMEOUT_MS = '5000';
process.env.MAX_SELECTED_TABLES = '100';
