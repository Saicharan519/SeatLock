import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { signWebhook, SIGNATURE_HEADER, type GatewayEvent } from '@seatlock/shared';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';

/**
 * The webhook handler driven directly with hand-signed events, so every row of the
 * PRD 9.3 decision table can be set up exactly. The gateway client accepts charges
 * and sends nothing; these tests play the gateway.
 */
describe('POST /api/webhooks/payment (FR-10, PRD 9.3)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;
  const secret = process.env.WEBHOOK_SECRET!;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  /** Holds A1, A2 and starts a payment. Returns ids for building events. */
  async function pendingPayment() {
    const showId = await createShow(pool, { pricePerSeat: 20000 });
    const user = await createUser(pool);
    const hold = await request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats: ['A1', 'A2'] });
    const pay = await request(app)
      .post(`/api/bookings/${hold.body.bookingId}/pay`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send();
    return {
      showId,
      bookingId: hold.body.bookingId as string,
      paymentId: pay.body.paymentId as string,
    };
  }

  const event = (
    type: GatewayEvent['type'],
    paymentId: string,
    extra: Partial<GatewayEvent['data']> = {},
  ): GatewayEvent => ({
    id: `evt_${randomUUID()}`,
    type,
    data: { paymentId, chargeId: 'ch_123', amount: 40000, ...extra },
    createdAt: new Date().toISOString(),
  });

  const deliver = (
    e: GatewayEvent,
    opts: { timestamp?: number; signWith?: string; body?: string } = {},
  ) => {
    const body = opts.body ?? JSON.stringify(e);
    return request(app)
      .post('/api/webhooks/payment')
      .set('content-type', 'application/json')
      .set(
        SIGNATURE_HEADER,
        signWebhook(opts.signWith ?? secret, JSON.stringify(e), opts.timestamp),
      )
      .send(body);
  };

  const state = async (bookingId: string) =>
    (
      await pool.query(
        `SELECT b.status AS booking, p.status AS payment,
                (SELECT json_agg(s.status ORDER BY s.id) FROM seats s WHERE s.booking_id = b.id) AS seats,
                (SELECT count(*)::int FROM outbox_events) AS events,
                (SELECT json_agg(event_type ORDER BY id) FROM outbox_events) AS event_types
         FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1`,
        [bookingId],
      )
    ).rows[0];

  describe('T10: authentication', () => {
    test('rejects a wrong secret, a stale timestamp, a tampered body and a missing header', async () => {
      const { bookingId, paymentId } = await pendingPayment();
      const e = event('payment.succeeded', paymentId);
      const now = Math.floor(Date.now() / 1000);

      const attempts = [
        deliver(e, { signWith: 'not-the-real-secret-at-all' }),
        deliver(e, { timestamp: now - 301 }),
        deliver(e, { timestamp: now + 301 }),
        deliver(e, { body: JSON.stringify({ ...e, data: { ...e.data, amount: 1 } }) }),
        request(app)
          .post('/api/webhooks/payment')
          .set('content-type', 'application/json')
          .send(JSON.stringify(e)),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_SIGNATURE');
      }

      // No state change, and nothing recorded as received
      expect(await state(bookingId)).toMatchObject({
        booking: 'PENDING',
        payment: 'INITIATED',
        events: 0,
      });
      expect((await pool.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n).toBe(0);
    });

    test('accepts a timestamp within the 5-minute window', async () => {
      const { paymentId } = await pendingPayment();
      const res = await deliver(event('payment.succeeded', paymentId), {
        timestamp: Math.floor(Date.now() / 1000) - 290,
      });
      expect(res.status).toBe(200);
    });
  });

  test('success while the hold is live confirms the booking', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    const res = await deliver(event('payment.succeeded', paymentId));
    expect(res.body).toEqual({ received: true, result: 'confirmed' });
    expect(await state(bookingId)).toEqual({
      booking: 'CONFIRMED',
      payment: 'SUCCESS',
      seats: ['BOOKED', 'BOOKED'],
      events: 1,
      event_types: ['BookingConfirmed'],
    });
  });

  test('T6: the same event delivered twice, sequentially and concurrently, transitions once', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    const e = event('payment.succeeded', paymentId);

    const [a, b] = await Promise.all([deliver(e), deliver(e)]);
    const third = await deliver(e);
    expect([a.body.result, b.body.result].sort()).toEqual(['confirmed', 'duplicate']);
    expect(third.status).toBe(200);
    expect(third.body.result).toBe('duplicate');
    expect(await state(bookingId)).toMatchObject({ booking: 'CONFIRMED', events: 1 });
  });

  test('a different event id for an already-successful payment is ignored', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    await deliver(event('payment.succeeded', paymentId));
    const res = await deliver(event('payment.succeeded', paymentId));
    expect(res.body.result).toBe('ignored');
    expect((await state(bookingId)).events).toBe(1);
  });

  test('failure fails the booking and releases the seats; a later success is refunded', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    expect((await deliver(event('payment.failed', paymentId))).body.result).toBe('payment_failed');
    expect(await state(bookingId)).toMatchObject({
      booking: 'FAILED',
      payment: 'FAILED',
      seats: null,
    });

    // The customer was charged after all: never ignore it
    expect((await deliver(event('payment.succeeded', paymentId))).body.result).toBe(
      'refund_required',
    );
    expect(await state(bookingId)).toMatchObject({
      booking: 'FAILED',
      payment: 'REFUND_REQUIRED',
      event_types: ['RefundRequired'],
    });
  });

  test('success for a booking released or cancelled meanwhile is refunded, with no seat changes', async () => {
    const { showId, bookingId, paymentId } = await pendingPayment();
    // Simulate the booking having been cancelled while the payment was in flight
    await pool.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1`, [bookingId]);
    await pool.query(
      `UPDATE seats SET status = 'AVAILABLE', booking_id = NULL WHERE show_id = $1`,
      [showId],
    );

    expect((await deliver(event('payment.succeeded', paymentId))).body.result).toBe(
      'refund_required',
    );
    expect(await state(bookingId)).toMatchObject({
      booking: 'CANCELLED',
      payment: 'REFUND_REQUIRED',
    });
    const booked = await pool.query(
      `SELECT count(*)::int AS n FROM seats WHERE status <> 'AVAILABLE'`,
    );
    expect(booked.rows[0].n).toBe(0);
  });

  test('refund.succeeded moves REFUND_REQUIRED to REFUNDED, and only that', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    // Not owed a refund yet: ignored
    expect(
      (await deliver(event('refund.succeeded', paymentId, { refundId: 'rf_1' }))).body.result,
    ).toBe('ignored');

    await pool.query(`UPDATE payments SET status = 'REFUND_REQUIRED' WHERE id = $1`, [paymentId]);
    expect(
      (await deliver(event('refund.succeeded', paymentId, { refundId: 'rf_1' }))).body.result,
    ).toBe('refunded');
    const { rows } = await pool.query(`SELECT status, refund_reference FROM payments`);
    expect(rows[0]).toEqual({ status: 'REFUNDED', refund_reference: 'rf_1' });
    expect((await state(bookingId)).payment).toBe('REFUNDED');
  });

  test('unknown payments and wrong amounts are acknowledged but change nothing', async () => {
    const { bookingId, paymentId } = await pendingPayment();
    expect((await deliver(event('payment.succeeded', randomUUID()))).body.result).toBe('ignored');
    expect((await deliver(event('payment.succeeded', paymentId, { amount: 1 }))).body.result).toBe(
      'ignored',
    );
    expect(await state(bookingId)).toMatchObject({ booking: 'PENDING', payment: 'INITIATED' });
  });

  test('a malformed but correctly signed payload is a 400', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const res = await request(app)
      .post('/api/webhooks/payment')
      .set('content-type', 'application/json')
      .set(SIGNATURE_HEADER, signWebhook(secret, body))
      .send(body);
    expect(res.status).toBe(400);
  });
});
