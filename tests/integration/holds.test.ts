import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';

describe('POST /api/holds and release (FR-04, FR-06, FR-09)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(20);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const hold = (token: string, body: object, key: string | null = randomUUID()) => {
    const req = request(app).post('/api/holds').set('Authorization', `Bearer ${token}`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const release = (token: string, bookingId: string) =>
    request(app)
      .post(`/api/holds/${bookingId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send();
  const seatStatus = async (showId: string, label: string) =>
    (
      await pool.query(
        `SELECT status, booking_id FROM seats WHERE show_id = $1 AND seat_label = $2`,
        [showId, label],
      )
    ).rows[0];
  const count = async (table: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  test('holds seats and returns the booking', async () => {
    const showId = await createShow(pool, { pricePerSeat: 25000 });
    const user = await createUser(pool);

    const res = await hold(user.token, { showId, seats: ['a2', 'A1'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', seats: ['A1', 'A2'], totalAmount: 50000 });
    const expiresIn = new Date(res.body.expiresAt).getTime() - Date.now();
    // expiresAt comes from the database clock (R5), Date.now() from this process: on Docker
    // Desktop the two were measured up to ~0.7 s apart, so allow 2 s either way
    expect(expiresIn).toBeGreaterThan(290_000);
    expect(expiresIn).toBeLessThanOrEqual(302_000);

    expect(await seatStatus(showId, 'A1')).toEqual({
      status: 'HELD',
      booking_id: res.body.bookingId,
    });
    const items = await pool.query(`SELECT price, is_confirmed FROM booking_items`);
    expect(items.rows).toEqual([
      { price: 25000, is_confirmed: false },
      { price: 25000, is_confirmed: false },
    ]);
  });

  test('rejects missing auth, missing key, bad seat lists, unknown shows and started shows', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);

    expect(
      (
        await request(app)
          .post('/api/holds')
          .send({ showId, seats: ['A1'] })
      ).status,
    ).toBe(401);
    const noKey = await hold(user.token, { showId, seats: ['A1'] }, null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    for (const seats of [
      [],
      ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
      ['A1', 'a1'],
      ['A11'],
      ['Z1'],
    ]) {
      const res = await hold(user.token, { showId, seats });
      expect({ seats, status: res.status, code: res.body.error.code }).toEqual({
        seats,
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }

    const unknownShow = await hold(user.token, { showId: randomUUID(), seats: ['A1'] });
    expect(unknownShow.status).toBe(404);

    const started = await createShow(pool, { startsAt: new Date(Date.now() - 60_000) });
    const late = await hold(user.token, { showId: started, seats: ['A1'] });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('INVALID_STATE');

    expect(await count('bookings')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
  });

  test('a seat held by someone else gives SEAT_UNAVAILABLE and leaves no trace', async () => {
    const showId = await createShow(pool);
    const [priya, rahul] = [await createUser(pool), await createUser(pool)];
    await hold(priya.token, { showId, seats: ['A2'] });

    // All-or-nothing: A1 is free, but A2 is not, so neither is held
    const key = randomUUID();
    const res = await hold(rahul.token, { showId, seats: ['A1', 'A2'] }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    expect((await seatStatus(showId, 'A1')).status).toBe('AVAILABLE');
    expect(await count('bookings')).toBe(1);

    // Failures aren't stored, so retrying the same key re-executes (PRD 9.7)
    const retry = await hold(rahul.token, { showId, seats: ['A1', 'A2'] }, key);
    expect(retry.status).toBe(409);
    const different = await hold(rahul.token, { showId, seats: ['A1'] }, key);
    expect(different.status).toBe(201);
  });

  test('T3 (hold): the same key sent 20 times concurrently creates one booking', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => hold(user.token, { showId, seats: ['B1', 'B2'] }, key)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(new Set(responses.map((r) => r.body.bookingId)).size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
    expect(await count('bookings')).toBe(1);
    expect(await count('booking_items')).toBe(2);
  });

  test('a replay returns the stored response, even if seat order differs', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const key = randomUUID();
    const first = await hold(user.token, { showId, seats: ['C1', 'C2'] }, key);
    const again = await hold(user.token, { showId, seats: ['C2', 'C1'] }, key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  test('T4: the same key with a different body gives 422', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const key = randomUUID();
    await hold(user.token, { showId, seats: ['A1'] }, key);

    const res = await hold(user.token, { showId, seats: ['A2'] }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await seatStatus(showId, 'A2')).status).toBe('AVAILABLE');
  });

  test('one live hold per user per show, including two concurrent attempts', async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);

    const [a, b] = await Promise.all([
      hold(user.token, { showId, seats: ['A1'] }),
      hold(user.token, { showId, seats: ['B1'] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('ACTIVE_HOLD_EXISTS');

    const third = await hold(user.token, { showId, seats: ['C1'] });
    expect(third.body.error.code).toBe('ACTIVE_HOLD_EXISTS');

    // A different show is fine
    const otherShow = await createShow(pool);
    expect((await hold(user.token, { showId: otherShow, seats: ['A1'] })).status).toBe(201);
  });

  test("the caller's own stale hold is expired and its seats released in the same transaction", async () => {
    const showId = await createShow(pool);
    const user = await createUser(pool);
    const stale = await holdSeatsDirectly(pool, {
      userId: user.id,
      showId,
      labels: ['A1', 'A2'],
      expiresInSeconds: -1,
    });

    // Overlaps the stale hold on A2
    const res = await hold(user.token, { showId, seats: ['A2', 'A3'] });
    expect(res.status).toBe(201);

    const old = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [stale]);
    expect(old.rows[0].status).toBe('EXPIRED');
    expect(await seatStatus(showId, 'A1')).toEqual({ status: 'AVAILABLE', booking_id: null });
    expect((await seatStatus(showId, 'A2')).booking_id).toBe(res.body.bookingId);
    expect((await seatStatus(showId, 'A3')).booking_id).toBe(res.body.bookingId);
  });

  describe('release', () => {
    test('cancels a PENDING hold and frees its seats; releasing again is harmless', async () => {
      const showId = await createShow(pool);
      const user = await createUser(pool);
      const { body } = await hold(user.token, { showId, seats: ['A1', 'A2'] });

      const res = await release(user.token, body.bookingId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ bookingId: body.bookingId, status: 'CANCELLED' });
      expect(await seatStatus(showId, 'A1')).toEqual({ status: 'AVAILABLE', booking_id: null });

      expect((await release(user.token, body.bookingId)).body.status).toBe('CANCELLED');
      // The user can hold again straight away
      expect((await hold(user.token, { showId, seats: ['A1'] })).status).toBe(201);
    });

    test("someone else's booking is NOT_FOUND", async () => {
      const showId = await createShow(pool);
      const [owner, other] = [await createUser(pool), await createUser(pool)];
      const { body } = await hold(owner.token, { showId, seats: ['A1'] });

      const res = await release(other.token, body.bookingId);
      expect(res.status).toBe(404);
      expect((await seatStatus(showId, 'A1')).status).toBe('HELD');
    });

    test('refuses while a payment is INITIATED, and for non-PENDING bookings', async () => {
      const showId = await createShow(pool);
      const user = await createUser(pool);
      const { body } = await hold(user.token, { showId, seats: ['A1'] });
      await pool.query(
        `INSERT INTO payments (booking_id, amount, status) VALUES ($1, 20000, 'INITIATED')`,
        [body.bookingId],
      );

      const inFlight = await release(user.token, body.bookingId);
      expect(inFlight.status).toBe(409);
      expect(inFlight.body.error.code).toBe('PAYMENT_IN_PROGRESS');

      await pool.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1`, [body.bookingId]);
      const confirmed = await release(user.token, body.bookingId);
      expect(confirmed.status).toBe(409);
      expect(confirmed.body.error.code).toBe('INVALID_STATE');
    });
  });
});
