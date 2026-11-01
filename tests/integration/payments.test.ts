import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { startPaymentStack, waitFor } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';

/** End to end: real API, real mock gateway over HTTP, real signed webhooks. */
describe('payments end to end (FR-08, FR-11, FR-15, FR-16)', () => {
  let pool: Pool;
  let stack: Awaited<ReturnType<typeof startPaymentStack>>;

  beforeAll(async () => {
    pool = createTestPool(20);
    stack = await startPaymentStack(pool);
  });
  afterAll(async () => {
    await stack.stop();
    await pool.end();
  });
  beforeEach(async () => {
    // Don't let the previous test's scheduled webhooks land in this one
    stack.cancelPendingWebhooks();
    await resetDatabase(pool);
    stack.setMode('success');
  });

  const api = () => request(stack.api);
  const holdSeats = async (token: string, showId: string, seats: string[]) => {
    const res = await api()
      .post('/api/holds')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats });
    expect(res.status).toBe(201);
    return res.body.bookingId as string;
  };
  const pay = (token: string, bookingId: string, key: string = randomUUID()) =>
    api()
      .post(`/api/bookings/${bookingId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send();
  const getBooking = async (token: string, bookingId: string) =>
    (await api().get(`/api/bookings/${bookingId}`).set('Authorization', `Bearer ${token}`)).body
      .booking;
  const waitForStatus = (token: string, bookingId: string, status: string) =>
    waitFor(async () => (await getBooking(token, bookingId)).status === status);
  const seatStatuses = async (showId: string, labels: string[]) =>
    (
      await pool.query(
        `SELECT status FROM seats WHERE show_id = $1 AND seat_label = ANY($2) ORDER BY id`,
        [showId, labels],
      )
    ).rows.map((r) => r.status);

  test('S1: hold, pay, webhook confirms the booking', async () => {
    const showId = await createShow(pool, { pricePerSeat: 25000 });
    const rahul = await createUser(pool);
    const bookingId = await holdSeats(rahul.token, showId, ['A1', 'A2']);

    const res = await pay(rahul.token, bookingId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ paymentId: expect.any(String), status: 'INITIATED' });

    await waitForStatus(rahul.token, bookingId, 'CONFIRMED');
    const booking = await getBooking(rahul.token, bookingId);
    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      totalAmount: 50000,
      seats: ['A1', 'A2'],
      payment: { id: res.body.paymentId, status: 'SUCCESS' },
    });
    expect(await seatStatuses(showId, ['A1', 'A2'])).toEqual(['BOOKED', 'BOOKED']);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM booking_items WHERE is_confirmed) AS confirmed_items,
         (SELECT provider_reference FROM payments) AS provider_reference,
         (SELECT json_agg(event_type) FROM outbox_events) AS events`,
    );
    expect(rows[0]).toEqual({
      confirmed_items: 2,
      provider_reference: expect.stringMatching(/^ch_/),
      events: ['BookingConfirmed'],
    });

    // Booking history (FR-16)
    const mine = await api().get('/api/bookings/me').set('Authorization', `Bearer ${rahul.token}`);
    expect(mine.body.bookings).toHaveLength(1);
    expect(mine.body.bookings[0]).toMatchObject({ id: bookingId, status: 'CONFIRMED' });
  });

  test('T3 (pay) / S4: the same key sent 20 times concurrently makes one payment and one gateway call', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const bookingId = await holdSeats(user.token, showId, ['B1']);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => pay(user.token, bookingId, key)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(202));
    const paymentIds = new Set(responses.map((r) => r.body.paymentId));
    expect(paymentIds.size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);

    const [paymentId] = [...paymentIds] as string[];
    expect(stack.gateway.chargeCalls.get(paymentId!)).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(1);
    await waitForStatus(user.token, bookingId, 'CONFIRMED');
  });

  test('S8: a duplicated webhook confirms once and writes one event', async () => {
    stack.setMode('duplicate-webhook');
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const bookingId = await holdSeats(user.token, showId, ['C1']);
    await pay(user.token, bookingId);

    await waitForStatus(user.token, bookingId, 'CONFIRMED');
    // Give the second delivery time to arrive and be discarded
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM webhook_events) AS webhooks,
              (SELECT count(*)::int FROM outbox_events) AS events`,
    );
    expect(rows[0]).toEqual({ webhooks: 1, events: 1 });
  });

  test('S7 / T7 (webhook): a payment.failed webhook fails the booking and frees the seats', async () => {
    stack.setMode('fail');
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const bookingId = await holdSeats(user.token, showId, ['D1', 'D2']);
    expect((await pay(user.token, bookingId)).status).toBe(202);

    await waitForStatus(user.token, bookingId, 'FAILED');
    expect((await getBooking(user.token, bookingId)).payment.status).toBe('FAILED');
    expect(await seatStatuses(showId, ['D1', 'D2'])).toEqual(['AVAILABLE', 'AVAILABLE']);
  });

  test('T7 (rejection): a definite gateway rejection returns 502 and fails the booking', async () => {
    stack.setMode('reject');
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const bookingId = await holdSeats(user.token, showId, ['E1']);
    const key = randomUUID();

    const res = await pay(user.token, bookingId, key);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect(await getBooking(user.token, bookingId)).toMatchObject({
      status: 'FAILED',
      payment: { status: 'FAILED' },
    });
    expect(await seatStatuses(showId, ['E1'])).toEqual(['AVAILABLE']);

    // The stored response was updated, so a retry replays the 502
    const retry = await pay(user.token, bookingId, key);
    expect(retry.status).toBe(502);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  test('T18: a gateway timeout changes nothing, and the late webhook then confirms', async () => {
    // The gateway accepts the charge but never answers; the API gives up after 500 ms
    stack.setMode('timeout', { delayMs: 1500 });
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const bookingId = await holdSeats(user.token, showId, ['A5']);

    const res = await pay(user.token, bookingId);
    expect(res.status).toBe(202);
    expect(await getBooking(user.token, bookingId)).toMatchObject({
      status: 'PENDING',
      payment: { status: 'INITIATED' },
    });
    expect(await seatStatuses(showId, ['A5'])).toEqual(['HELD']);

    await waitForStatus(user.token, bookingId, 'CONFIRMED');
  });

  describe('pay is refused when it should be', () => {
    test('missing key, not the owner, already paid, expired, or not pending', async () => {
      const showId = await createShow(pool);
      const [owner, other] = [await createUser(pool), await createUser(pool)];
      const bookingId = await holdSeats(owner.token, showId, ['B5']);

      const noKey = await api()
        .post(`/api/bookings/${bookingId}/pay`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send();
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      expect((await pay(other.token, bookingId)).status).toBe(404);
      expect(
        (
          await api()
            .get(`/api/bookings/${bookingId}`)
            .set('Authorization', `Bearer ${other.token}`)
        ).status,
      ).toBe(404);

      expect((await pay(owner.token, bookingId)).status).toBe(202);
      const second = await pay(owner.token, bookingId);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('PAYMENT_IN_PROGRESS');

      // An expired hold can't be paid
      const expired = await holdSeats(other.token, showId, ['B6']);
      await pool.query(
        `UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [expired],
      );
      const late = await pay(other.token, expired);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('BOOKING_NOT_PAYABLE');
    });

    test('a key used for a hold cannot be reused for a payment', async () => {
      const showId = await createShow(pool);
      const user = await createUser(pool);
      const key = randomUUID();
      const hold = await api()
        .post('/api/holds')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', key)
        .send({ showId, seats: ['C5'] });

      const res = await pay(user.token, hold.body.bookingId, key);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
});
