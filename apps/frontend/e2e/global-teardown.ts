import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function globalTeardown() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    execFileSync('npm', ['run', 'seed', '-w', 'apps/backend'], {
      cwd: rootDir,
      env: process.env,
      stdio: 'ignore'
    });
  } catch {
    console.warn('E2E teardown could not restore the seeded model configuration.');
  }
}
