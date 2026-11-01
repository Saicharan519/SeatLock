import { createLogger, createRedisClient, type Redis } from '@seatlock/shared';

/** Redis database 1, so tests never touch the dev data in database 0. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

const silent = createLogger('redis-test', process.env.TEST_LOG_LEVEL ?? 'silent');

/** A client configured exactly like the API's, connected and ready. */
export async function connectTestRedis(url = TEST_REDIS_URL): Promise<Redis> {
  const redis = createRedisClient(url, silent);
  if (redis.status !== 'ready') {
    let giveUp: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', () => resolve());
      giveUp = setTimeout(() => reject(new Error(`redis at ${url} not ready`)), 5000);
    }).finally(() => clearTimeout(giveUp)); // a pending timer would keep Jest alive
  }
  return redis;
}

/**
 * Graceful QUIT for a connected client, plain disconnect otherwise.
 *
 * Note: ioredis keeps the process alive for about 2.3 s after any refused connection attempt,
 * whatever its options (measured on Windows and Linux). Harmless for the API, but a test file
 * that creates a refused client in its last moments makes Jest wait. Hence unreachableRedis()
 * is only used mid-file in T13; health.test.ts uses a stub instead.
 */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') await redis.quit().catch(() => redis.disconnect());
  else redis.disconnect();
}

/** A client pointed at a port where nothing listens: Redis "down" from the start. */
export function unreachableRedis(): Redis {
  return createRedisClient('redis://127.0.0.1:6390', silent);
}
