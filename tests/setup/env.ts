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
// Never use real gateway keys from a developer's .env: tests that need Cashfree pass a fake
// server's keys explicitly. (Assigning '' would still count as "set", so delete them.)
for (const key of [
  'CASHFREE_APP_ID',
  'CASHFREE_SECRET_KEY',
  'CASHFREE_BASE_URL',
  'CASHFREE_NOTIFY_URL',
  'SITE_URL',
  'ORIGIN_SECRET',
  'CLIENT_IP_HEADER',
]) {
  delete process.env[key];
}
