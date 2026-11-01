import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './testDatabaseUrl';

/** Brings the test database schema up to date once per Jest run. */
export default function globalSetup() {
  execSync('npx node-pg-migrate up -m packages/db/migrations --no-verbose', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
