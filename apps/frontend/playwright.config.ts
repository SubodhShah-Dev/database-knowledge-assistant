import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(frontendDir, '../..');
const stubPort = 4010;
const apiPort = 4100;
const webPort = 5273;

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined)
) as Record<string, string>;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: 'node e2e/llm-stub.mjs',
      cwd: frontendDir,
      url: `http://127.0.0.1:${stubPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: 'npm run seed -w apps/backend && npm run dev -w apps/backend',
      cwd: rootDir,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...baseEnv,
        NODE_ENV: 'test',
        PORT: String(apiPort),
        FRONTEND_ORIGIN: `http://127.0.0.1:${webPort}`,
        LLM_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
        LLM_API_KEY: 'e2e-stub-key'
      }
    },
    {
      command: `npm run dev -w apps/frontend -- --port ${webPort} --strictPort`,
      cwd: rootDir,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...baseEnv,
        VITE_API_URL: `http://127.0.0.1:${apiPort}`
      }
    }
  ]
});
