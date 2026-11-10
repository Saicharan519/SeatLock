/**
 * The backend for the browser tests, in one process: prepares a dedicated database
 * (seatlock_e2e, never the development or Jest one), then starts the API, worker and mock
 * gateway exactly as the hosted site does (all-in-one mode).
 *
 * Every run starts from the same state: migrated, emptied, then seeded with the demo
 * catalogue and an admin. Playwright starts this before the tests (playwright.config.ts).
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL!);
const database = url.pathname.slice(1);
if (!database.endsWith('_e2e')) {
  // This script empties the database: refuse anything that isn't clearly the e2e one
  throw new Error(`Refusing to reset "${database}": the e2e database name must end in _e2e`);
}

async function prepareDatabase() {
  // 1. Create it if missing (connect to the server's default database to do that)
  const admin = new pg.Client({
    connectionString: url.toString().replace(/\/[^/?]+(\?|$)/, '/postgres$1'),
  });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  // 2. Migrate
  const run = (args: string[]) => {
    const r = spawnSync('npx', args, { stdio: 'inherit', shell: true, env: process.env });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed`);
  };
  run(['node-pg-migrate', 'up', '-m', 'packages/db/migrations', '--no-verbose']);

  // 3. Empty every table, so each run starts from the same state
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
  );
  await db.query(
    `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await db.end();

  // 4. The demo catalogue (films, theatres, a week of shows) and the admin account
  run(['tsx', 'packages/db/src/seed.ts']);
}

prepareDatabase()
  .then(() => import('../apps/all-in-one/src/index.js'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
