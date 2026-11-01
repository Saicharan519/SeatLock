import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createHttpGatewayClient } from '@seatlock/shared';
import { createConsumers } from '../../apps/worker/src/consumers';
import { claimOutboxEvents, processOutbox } from '../../apps/worker/src/outbox/processOutbox';
import { startPaymentStack, waitFor } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';
import { outboxOptions } from '../helpers/outbox';

/**
 * End to end: real API, real mock gateway over HTTP, and the worker's outbox processor
 * with the real consumers. Money goes out and the refund webhook comes back.
 */
describe('refunds and notifications end to end (S9, FR-17)', () => {
  let pool: Pool;
  let stack: Awaited<ReturnType<typeof startPaymentStack>>;
  let opts: ReturnType<typeof outboxOptions>;

  beforeAll(async () => {
    pool = createTestPool(20);
    stack = await startPaymentStack(pool);
    opts = outboxOptions(
      createConsumers({
        pool,
        gateway: createHttpGatewayClient(stack.gatewayUrl, 2000),
        webhookUrl: `${stack.apiUrl}/api/webhooks/payment`,
      }),
    );
  });
  afterAll(async () => {
    await stack.stop();
    await pool.end();
  });
  beforeEach(async () => {
    stack.cancelPendingWebhooks();
    await resetDatabase(pool);
    stack.setMode('success');
  });

  const api = () => request(stack.api);
  const paymentStatus = async (bookingId: string) =>
    (
      await pool.query(`SELECT status, refund_reference FROM payments WHERE booking_id = $1`, [
        bookingId,
      ])
    ).rows[0];

  /** Hold, pay and wait for the real webhook to confirm. */
  async function confirmed(seats = ['A1', 'A2'], showId?: string) {
    const show = showId ?? (await createShow(pool));
    const user = await createUser(pool);
    const hold = await api()
      .post('/api/holds')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId: show, seats });
    const bookingId = hold.body.bookingId as string;
    await api()
      .post(`/api/bookings/${bookingId}/pay`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send();
    await waitFor(async () => (await paymentStatus(bookingId))?.status === 'SUCCESS');
    return { user, bookingId, showId: show };
  }

  test('S9: cancel -> outbox -> gateway refund -> refund webhook -> REFUNDED', async () => {
    const { user, bookingId } = await confirmed();
    const cancel = await api()
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send();
    expect(cancel.body.status).toBe('CANCELLED');
    expect((await paymentStatus(bookingId)).status).toBe('REFUND_REQUIRED');

    // One worker tick delivers BookingConfirmed (a notification) and RefundRequired (a refund call)
    expect(await processOutbox(pool, opts)).toBe(2);

    await waitFor(async () => (await paymentStatus(bookingId)).status === 'REFUNDED');
    expect((await paymentStatus(bookingId)).refund_reference).toMatch(/^rf_/);
    const { rows } = await pool.query(
      `SELECT (SELECT json_agg(status ORDER BY id) FROM outbox_events) AS events,
              (SELECT count(*)::int FROM notifications) AS notifications`,
    );
    expect(rows[0]).toEqual({ events: ['PUBLISHED', 'PUBLISHED'], notifications: 1 });
    const { rows: p } = await pool.query(`SELECT id FROM payments WHERE booking_id = $1`, [
      bookingId,
    ]);
    expect(stack.gateway.refundCalls.get(p[0].id)).toBe(1);
  });

  test('a late payment that lost its seats is refunded the same way', async () => {
    // Priya's payment arrives after her hold expired and Rahul took a seat
    stack.setMode('delayed', { delayMs: 600 });
    const showId = await createShow(pool);
    const priya = await createUser(pool);
    const hold = await api()
      .post('/api/holds')
      .set('Authorization', `Bearer ${priya.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats: ['B1', 'B2'] });
    const bookingId = hold.body.bookingId as string;
    await api()
      .post(`/api/bookings/${bookingId}/pay`)
      .set('Authorization', `Bearer ${priya.token}`)
      .set('Idempotency-Key', randomUUID())
      .send();
    await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      bookingId,
    ]);
    stack.setMode('success');
    await confirmed(['B2'], showId); // Rahul takes over B2 from the stale hold

    await waitFor(async () => (await paymentStatus(bookingId)).status === 'REFUND_REQUIRED');
    await processOutbox(pool, opts);
    await waitFor(async () => (await paymentStatus(bookingId)).status === 'REFUNDED');
  });

  test('the refund consumer is idempotent: running it twice refunds once', async () => {
    const { user, bookingId } = await confirmed();
    await api()
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send();

    const events = await claimOutboxEvents(pool, 10, 60);
    const refund = events.find((e) => e.event_type === 'RefundRequired')!;
    // A worker crashed after calling the gateway, and the event is delivered again
    await opts.consumers.RefundRequired!(refund);
    await opts.consumers.RefundRequired!(refund);

    await waitFor(async () => (await paymentStatus(bookingId)).status === 'REFUNDED');
    await new Promise((r) => setTimeout(r, 300)); // room for any second webhook to arrive
    // Two refund calls reached the gateway, but it paid out once and confirmed once
    const paymentId = (refund.payload as { paymentId: string }).paymentId;
    expect(stack.gateway.refundCalls.get(paymentId)).toBe(2);
    expect(stack.gateway.refunds.has(paymentId)).toBe(true);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE event_type = 'refund.succeeded'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
