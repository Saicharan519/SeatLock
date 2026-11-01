import request from 'supertest';
import type { Pool } from 'pg';
import { processOutbox } from '../../apps/worker/src/outbox/processOutbox';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createUser } from '../helpers/factories';
import { insertEvents, outboxOptions } from '../helpers/outbox';

/** FR-19: inspect dead outbox events, plus a retry endpoint (beyond the PRD). */
describe('admin outbox endpoints (FR-19)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(5);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  /** One event per status, the FAILED one with a realistic error. */
  async function seedEvents() {
    const [pending, failed, published] = await insertEvents(pool, 3, 'RefundRequired', {
      paymentId: 'p1',
      amount: 20000,
    });
    await pool.query(
      `UPDATE outbox_events SET status = 'FAILED', retry_count = 8,
              last_error = 'refund failed with status 404' WHERE id = $1`,
      [failed],
    );
    await pool.query(`UPDATE outbox_events SET status = 'PUBLISHED' WHERE id = $1`, [published]);
    return { pending: pending!, failed: failed!, published: published! };
  }
  const asAdmin = async () => `Bearer ${(await createUser(pool, 'ADMIN')).token}`;

  test('lists FAILED events by default, with the error and attempt count', async () => {
    const { failed } = await seedEvents();
    const res = await request(app)
      .get('/api/admin/outbox-events')
      .set('Authorization', await asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      expect.objectContaining({
        id: failed,
        eventType: 'RefundRequired',
        status: 'FAILED',
        retryCount: 8,
        lastError: 'refund failed with status 404',
        payload: { paymentId: 'p1', amount: 20000 },
      }),
    ]);
  });

  test('filters by status and validates the query', async () => {
    const { published } = await seedEvents();
    const auth = await asAdmin();
    const ok = await request(app)
      .get('/api/admin/outbox-events?status=PUBLISHED&limit=10')
      .set('Authorization', auth);
    expect(ok.body.events.map((e: { id: string }) => e.id)).toEqual([published]);

    const bad = await request(app)
      .get('/api/admin/outbox-events?status=NOPE')
      .set('Authorization', auth);
    expect(bad.status).toBe(400);
    const tooMany = await request(app)
      .get('/api/admin/outbox-events?limit=1000')
      .set('Authorization', auth);
    expect(tooMany.status).toBe(400);
  });

  test('is admin-only', async () => {
    expect((await request(app).get('/api/admin/outbox-events')).status).toBe(401);
    const user = await createUser(pool);
    const res = await request(app)
      .get('/api/admin/outbox-events')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(403);
    const retry = await request(app)
      .post('/api/admin/outbox-events/1/retry')
      .set('Authorization', `Bearer ${user.token}`);
    expect(retry.status).toBe(403);
  });

  test('retry sends a FAILED event back with a fresh attempt budget, and the worker then delivers it', async () => {
    const { failed } = await seedEvents();
    const res = await request(app)
      .post(`/api/admin/outbox-events/${failed}/retry`)
      .set('Authorization', await asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({
      id: failed,
      status: 'PENDING',
      retryCount: 0,
      lastError: 'refund failed with status 404', // history kept
    });

    // The cause is fixed (here: a consumer that now works); the next tick publishes it
    let delivered = 0;
    await processOutbox(
      pool,
      outboxOptions({
        RefundRequired: async () => {
          delivered += 1;
        },
      }),
    );
    expect(delivered).toBe(2); // the requeued event and the one that was already PENDING
    const { rows } = await pool.query(`SELECT status FROM outbox_events WHERE id = $1`, [failed]);
    expect(rows[0].status).toBe('PUBLISHED');
  });

  test('retry refuses events that are not FAILED, and unknown ids', async () => {
    const { pending, published } = await seedEvents();
    const auth = await asAdmin();
    for (const id of [pending, published]) {
      const res = await request(app)
        .post(`/api/admin/outbox-events/${id}/retry`)
        .set('Authorization', auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    }
    expect(
      (await request(app).post('/api/admin/outbox-events/999999/retry').set('Authorization', auth))
        .status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/admin/outbox-events/abc/retry').set('Authorization', auth))
        .status,
    ).toBe(404);
  });
});
