import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';
import { createPool } from './pool';
import { seedCatalog } from './seedCatalog';
import { withTransaction } from './transaction';

/**
 * Creates the admin user and the demo catalogue: movies, theatres, screens, and a week of
 * showtimes from today. Safe to run repeatedly: everything is upserted, and showtimes are
 * only topped up, so re-running it later keeps the demo bookable.
 */
const env = loadEnv(
  baseEnvSchema.extend({
    SEED_ADMIN_EMAIL: z.email().default('admin@seatlock.local'),
    SEED_ADMIN_PASSWORD: z.string().min(8).default('admin12345'),
    SEED_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  }),
);

async function main() {
  const pool = createPool({ connectionString: env.DATABASE_URL, max: 2, acquireTimeoutMs: 10000 });
  try {
    const started = Date.now();
    const result = await withTransaction(pool, async (client) => {
      const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 10);
      await client.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', $1, $2, 'ADMIN')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'ADMIN'`,
        [env.SEED_ADMIN_EMAIL.toLowerCase(), passwordHash],
      );
      return seedCatalog(client, { days: env.SEED_DAYS });
    });
    console.log(
      `Catalogue ready: ${result.movies} movies, ${result.theatres} theatres, ` +
        `${result.screens} screens; ${result.showsCreated} shows added, ` +
        `${result.showsSkipped} already there (${Date.now() - started} ms)`,
    );
    console.log(`Admin user ready: ${env.SEED_ADMIN_EMAIL}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
