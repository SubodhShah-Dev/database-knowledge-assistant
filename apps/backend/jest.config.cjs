module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  globalSetup: '<rootDir>/test/globalSetup.cjs',
  setupFiles: ['<rootDir>/test/setEnv.ts'],
  testTimeout: 30000
};
