export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testMatch: ['**/?(*.)+(e2e).[jt]s?(x)'], // Match E2E test files
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};
