import { TEST_DATABASE_URL } from './testDatabaseUrl';

// Runs before each test file, before any app module reads process.env.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars';
process.env.WEBHOOK_SECRET = 'test-webhook-secret-at-least-16';
process.env.HOLD_TTL_SECONDS = '5';
process.env.BCRYPT_ROUNDS = '4';
process.env.RATE_LIMIT_ENABLED = 'false';
