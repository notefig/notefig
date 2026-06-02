export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.metrists/'],
  testMatch: ['**/?(*.)+(e2e|contract).test.[jt]s?(x)'], // Match E2E + contract test files
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.metrists/'],
};
