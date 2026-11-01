/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@seatlock/db$': '<rootDir>/packages/db/src/index.ts',
    '^@seatlock/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
  globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
  setupFiles: ['<rootDir>/tests/setup/env.ts'],
  testTimeout: 30000,
};
