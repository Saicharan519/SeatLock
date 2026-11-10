import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests: a few complete flows through the real UI, real API, worker and
 * mock gateway, on a dedicated database. Not a full UI suite: the API's behaviour is covered
 * by the Jest integration tests; these prove the pieces work together in a browser.
 *
 * The frontend runs as the production build (vite preview), so the production
 * Content-Security-Policy from vercel.json is in force during the tests too.
 */
const API_PORT = 3100;
const WEB_PORT = 4273;

export const E2E = {
  web: `http://127.0.0.1:${WEB_PORT}`,
  api: `http://127.0.0.1:${API_PORT}`,
  adminEmail: 'admin@seatlock.local',
  /** A throwaway password for the e2e database's admin only */
  adminPassword: 'e2e-admin-password',
};

const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://seatlock:seatlock@localhost:5433/seatlock_e2e';

export default defineConfig({
  testDir: 'e2e',
  // One shared database and seat map: tests run one at a time, in a known order
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E.web,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/server.ts',
      url: `${E2E.api}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        // Nothing from the developer's .env (it may hold real gateway keys)
        DOTENV_CONFIG_PATH: 'e2e/.no-env',
        DOTENV_CONFIG_QUIET: 'true',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL: databaseUrl,
        REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/2',
        PORT: String(API_PORT),
        GATEWAY_PORT: '4100',
        JWT_SECRET: 'e2e-jwt-secret-not-used-anywhere-else',
        WEBHOOK_SECRET: 'e2e-webhook-secret-not-used-anywhere-else',
        // Many sign-ups from one IP in a few seconds; rate limiting has its own Jest tests
        RATE_LIMIT_ENABLED: 'false',
        WORKER_INTERVAL_MS: '1000',
        CATALOG_MAINTENANCE_HOURS: '0',
        SEED_ADMIN_PASSWORD: E2E.adminPassword,
      },
    },
    {
      command: `npm --prefix frontend run build && npm --prefix frontend run preview -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: E2E.web,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { API_URL: E2E.api },
    },
  ],
});
