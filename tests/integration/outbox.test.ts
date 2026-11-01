import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Pool } from 'pg';
import { createConsumers } from '../../apps/worker/src/consumers';
import {
  claimOutboxEvents,
  markPublished,
  processOutbox,
  type Consumer,
} from '../../apps/worker/src/outbox/processOutbox';
import { acceptingGateway, createTestApp, waitFor } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { eventRow, insertEvents, outboxOptions } from '../helpers/outbox';
import { deliverEvent, gatewayEvent, pendingPayment } from '../helpers/webhooks';

/** PRD 9.5: transactional outbox with leases, retries and idempotent consumers. */
describe('outbox processing (FR-13, FR-14)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const realConsumers = () =>
    createConsumers({ pool, gateway: acceptingGateway, webhookUrl: 'http://unused' });

  /** A confirmed booking whose BookingConfirmed event is still PENDING in the outbox. */
  async function confirmedBooking() {
    const p = await pendingPayment(pool, app);
    await deliverEvent(app, gatewayEvent('payment.succeeded', p.paymentId));
    const { rows } = await pool.query(
      `SELECT id FROM outbox_events WHERE event_type = 'BookingConfirmed' AND aggregate_id = $1`,
      [p.bookingId],
    );
    return { ...p, eventId: rows[0].id as string };
  }
  const notifications = async () =>
    (await pool.query(`SELECT event_id, user_id, type, payload FROM notifications`)).rows;

  test('S5: an event committed with the booking is delivered when a worker next runs', async () => {
    // The API committed the booking and its event; no worker was running (crashed, deploying...)
    const { user, bookingId, eventId } = await confirmedBooking();
    expect((await eventRow(pool, eventId)).status).toBe('PENDING');

    expect(await processOutbox(pool, outboxOptions(realConsumers()))).toBe(1);

    expect(await eventRow(pool, eventId)).toMatchObject({ status: 'PUBLISHED', published: true });
    expect(await notifications()).toEqual([
      {
        event_id: eventId,
        user_id: user.id,
        type: 'BOOKING_CONFIRMED',
        payload: expect.objectContaining({ bookingId, seats: ['A1', 'A2'] }),
      },
    ]);
    // Nothing left to do
    expect(await processOutbox(pool, outboxOptions(realConsumers()))).toBe(0);
  });

  test('the notification consumer is idempotent: a duplicate delivery adds nothing', async () => {
    const { eventId } = await confirmedBooking();
    const [event] = await claimOutboxEvents(pool, 10, 60);
    const consumer = realConsumers().BookingConfirmed!;

    await consumer(event!);
    await consumer(event!); // at-least-once: the same event delivered again
    expect(await notifications()).toHaveLength(1);
    expect((await notifications())[0].event_id).toBe(eventId);
  });

  test('a failure goes back to PENDING with backoff, and succeeds on a later attempt', async () => {
    const [id] = await insertEvents(pool, 1);
    let calls = 0;
    const flaky: Consumer = async () => {
      calls += 1;
      if (calls < 3) throw new Error(`gateway unreachable (attempt ${calls})`);
    };
    const opts = outboxOptions({ Test: flaky });

    await processOutbox(pool, opts);
    expect(await eventRow(pool, id!)).toMatchObject({
      status: 'PENDING',
      retry_count: 1,
      last_error: 'gateway unreachable (attempt 1)',
      backing_off: true,
    });
    // Not due yet: a second tick leaves it alone
    expect(await processOutbox(pool, opts)).toBe(0);
    expect(calls).toBe(1);

    // Fast-forward past the backoff twice
    for (const expectedRetries of [2, 2]) {
      await pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [id]);
      await processOutbox(pool, opts);
      expect((await eventRow(pool, id!)).retry_count).toBe(expectedRetries);
    }
    expect(calls).toBe(3);
    expect(await eventRow(pool, id!)).toMatchObject({ status: 'PUBLISHED', last_error: null });
  });

  test('the retry delay grows exponentially', async () => {
    const [id] = await insertEvents(pool, 1);
    const opts = outboxOptions(
      {
        Test: async () => {
          throw new Error('down');
        },
      },
      { backoffBaseMs: 10_000 },
    );
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [id]);
      await processOutbox(pool, opts);
      const { rows } = await pool.query(
        `SELECT round(extract(epoch FROM next_attempt_at - now()))::int AS s FROM outbox_events WHERE id = $1`,
        [id],
      );
      delays.push(rows[0].s);
    }
    expect(delays).toEqual([10, 20, 40]);
  });

  test('after the maximum attempts the event is FAILED and stays there', async () => {
    const [id] = await insertEvents(pool, 1);
    let calls = 0;
    const opts = outboxOptions(
      {
        Test: async () => {
          calls += 1;
          throw new Error('permanently broken');
        },
      },
      { maxAttempts: 3, backoffBaseMs: 0 },
    );

    // One attempt per worker tick: a failed event waits for the next tick, even with no backoff
    for (let tick = 1; tick <= 2; tick++) {
      await processOutbox(pool, opts);
      expect(await eventRow(pool, id!)).toMatchObject({ status: 'PENDING', retry_count: tick });
    }
    await processOutbox(pool, opts);
    expect(await eventRow(pool, id!)).toMatchObject({
      status: 'FAILED',
      retry_count: 3,
      last_error: 'permanently broken',
    });
    expect(calls).toBe(3);
    expect(await processOutbox(pool, opts)).toBe(0);
  });

  test('a handler that hangs is timed out and retried; an unknown event type fails', async () => {
    const [hanging] = await insertEvents(pool, 1, 'Hang');
    const [unknown] = await insertEvents(pool, 1, 'NoSuchType');
    const opts = outboxOptions({ Hang: () => new Promise(() => {}) }, { handlerTimeoutMs: 200 });

    await processOutbox(pool, opts);
    expect(await eventRow(pool, hanging!)).toMatchObject({
      status: 'PENDING',
      retry_count: 1,
      last_error: 'handler timed out after 200 ms',
    });
    expect(await eventRow(pool, unknown!)).toMatchObject({
      status: 'PENDING',
      last_error: 'no consumer for event type NoSuchType',
    });
  });

  test('fencing: a worker whose lease expired cannot record a result over the newer claim', async () => {
    const [id] = await insertEvents(pool, 1);
    const [stale] = await claimOutboxEvents(pool, 10, 60); // worker A claims
    // A stalls; its lease runs out
    await pool.query(
      `UPDATE outbox_events SET locked_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

    const [fresh] = await claimOutboxEvents(pool, 10, 60); // worker B re-claims
    expect(fresh!.id).toBe(id);
    expect(fresh!.retry_count).toBe(1); // the expired lease counted as an attempt
    expect(fresh!.lease_token).not.toBe(stale!.lease_token);

    expect(await markPublished(pool, fresh!)).toBe(true); // B finishes first
    expect(await markPublished(pool, stale!)).toBe(false); // A wakes up: ignored
    expect((await eventRow(pool, id!)).status).toBe('PUBLISHED');
  });

  test('an event that keeps killing its worker ends up FAILED without running again', async () => {
    const [id] = await insertEvents(pool, 1);
    let calls = 0;
    const opts = outboxOptions(
      {
        Test: async () => {
          calls += 1;
        },
      },
      { maxAttempts: 3 },
    );
    // Simulate three crashed workers: claim, then let the lease expire, three times
    for (let i = 0; i < 3; i++) {
      await claimOutboxEvents(pool, 10, 60);
      await pool.query(
        `UPDATE outbox_events SET locked_until = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
    }

    await processOutbox(pool, opts);
    expect(calls).toBe(0);
    expect(await eventRow(pool, id!)).toMatchObject({
      status: 'FAILED',
      last_error: 'too many expired leases',
    });
  });

  test('T12: two workers at once never process the same event twice', async () => {
    const ids = await insertEvents(pool, 60);
    const handled = new Map<string, number>();
    const counting: Consumer = async (event) => {
      handled.set(event.id, (handled.get(event.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10)); // overlap the workers
    };
    const opts = outboxOptions({ Test: counting }, { batchSize: 7 });

    const [a, b] = await Promise.all([processOutbox(pool, opts), processOutbox(pool, opts)]);

    expect(a + b).toBe(60);
    expect(a).toBeGreaterThan(0); // both workers really took part
    expect(b).toBeGreaterThan(0);
    expect(handled.size).toBe(60);
    expect([...handled.values()].every((n) => n === 1)).toBe(true);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE status = 'PUBLISHED' AND id = ANY($1::bigint[])`,
      [ids],
    );
    expect(rows[0].n).toBe(60);
  });

  describe('T11: a worker killed mid-handler', () => {
    let child: ChildProcess | undefined;
    afterEach(() => child?.kill('SIGKILL'));

    test('the lease expires, another worker re-claims the event, exactly one notification exists', async () => {
      const { eventId } = await confirmedBooking();
      const root = path.resolve(__dirname, '../..');

      // A real separate OS process running the outbox, which dies after the side effect
      // `node --import tsx`, NOT the `tsx` CLI: the CLI is a launcher that runs the script in
      // a second process, so SIGKILL would hit the launcher and orphan the real worker.
      child = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(root, 'tests/fixtures/crashingWorker.ts')],
        { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let giveUp: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.on(
          'data',
          (d: Buffer) => d.toString().includes('SIDE_EFFECT_DONE') && resolve(),
        );
        child!.on('exit', (code) => reject(new Error(`crashing worker exited early (${code})`)));
        giveUp = setTimeout(
          () => reject(new Error('crashing worker never reached the side effect')),
          20_000,
        );
      }).finally(() => clearTimeout(giveUp)); // a pending timer would keep Jest alive

      // Side effect done, result never recorded
      expect(await notifications()).toHaveLength(1);
      expect((await eventRow(pool, eventId)).status).toBe('PROCESSING');

      // Kill it: no cleanup, no graceful shutdown
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      const workerPid = child.pid!;
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      // The process that did the side effect is really gone (signal 0 only checks existence)
      expect(() => process.kill(workerPid, 0)).toThrow();

      // Still PROCESSING, owned by a dead worker. A healthy worker can't take it until the lease expires.
      expect(await processOutbox(pool, outboxOptions(realConsumers()))).toBe(0);
      await waitFor(async () => {
        const { rows } = await pool.query(
          `SELECT locked_until < now() AS expired FROM outbox_events WHERE id = $1`,
          [eventId],
        );
        return rows[0].expired;
      }, 5000);

      // A healthy worker re-claims it and runs the consumer again
      expect(await processOutbox(pool, outboxOptions(realConsumers()))).toBe(1);
      expect(await eventRow(pool, eventId)).toMatchObject({ status: 'PUBLISHED', retry_count: 1 });
      // The second run hit notifications.event_id UNIQUE: still exactly one
      expect(await notifications()).toHaveLength(1);
    }, 40_000);
  });
});
