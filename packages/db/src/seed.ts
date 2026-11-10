import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';
import { createPool } from './pool';
import { seedCatalog } from './seedCatalog';
import { withTransaction } from './transaction';

/**
 * Creates the admin user, an optional demo user, and the demo catalogue: movies, theatres,
 * screens, and a week of showtimes from today. Safe to run repeatedly: everything is
 * upserted and showtimes are only topped up, so re-running it later keeps the demo bookable.
 *
 * Passwords: outside production the admin gets a well-known local default. In production
 * there is no default (it would be public in this repository): the admin is created only
 * if SEED_ADMIN_PASSWORD is set.
 */
const env = loadEnv(
  baseEnvSchema.extend({
    SEED_ADMIN_EMAIL: z.email().default('admin@seatlock.local'),
    SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
    /** A shared account visitors can use to try the site without signing up */
    SEED_DEMO_EMAIL: z.email().optional(),
    SEED_DEMO_PASSWORD: z.string().min(8).optional(),
    SEED_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  }),
);

const LOCAL_ADMIN_PASSWORD = 'admin12345';

async function upsertUser(
  client: PoolClient,
  user: { name: string; email: string; password: string; role: 'USER' | 'ADMIN' },
) {
  const passwordHash = await bcrypt.hash(user.password, 10);
  await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [user.name, user.email.toLowerCase(), passwordHash, user.role],
  );
}

async function main() {
  const adminPassword =
    env.SEED_ADMIN_PASSWORD ?? (env.NODE_ENV === 'production' ? undefined : LOCAL_ADMIN_PASSWORD);
  const pool = createPool({ connectionString: env.DATABASE_URL, max: 2, acquireTimeoutMs: 10000 });
  try {
    const started = Date.now();
    const result = await withTransaction(pool, async (client) => {
      if (adminPassword) {
        await upsertUser(client, {
          name: 'Admin',
          email: env.SEED_ADMIN_EMAIL,
          password: adminPassword,
          role: 'ADMIN',
        });
      }
      if (env.SEED_DEMO_EMAIL && env.SEED_DEMO_PASSWORD) {
        await upsertUser(client, {
          name: 'Demo Guest',
          email: env.SEED_DEMO_EMAIL,
          password: env.SEED_DEMO_PASSWORD,
          role: 'USER',
        });
      }
      return seedCatalog(client, { days: env.SEED_DAYS });
    });
    console.log(
      `Catalogue ready: ${result.movies} movies, ${result.theatres} theatres, ` +
        `${result.screens} screens; ${result.showsCreated} shows added, ` +
        `${result.showsSkipped} already there (${Date.now() - started} ms)`,
    );
    console.log(
      adminPassword
        ? `Admin user ready: ${env.SEED_ADMIN_EMAIL}`
        : 'Admin user NOT created: set SEED_ADMIN_PASSWORD (no default in production)',
    );
    if (env.SEED_DEMO_EMAIL && env.SEED_DEMO_PASSWORD) {
      console.log(`Demo user ready: ${env.SEED_DEMO_EMAIL}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
