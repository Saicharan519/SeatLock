import type { PoolClient } from 'pg';
import type { Queryable } from '@seatlock/db';
import { logTransition } from '../utils/transitionLog';

export type PaymentProvider = 'MOCK' | 'CASHFREE';

export type PaymentStatus = 'INITIATED' | 'SUCCESS' | 'FAILED' | 'REFUND_REQUIRED' | 'REFUNDED';

export interface PaymentRow {
  id: string;
  booking_id: string;
  amount: number;
  status: PaymentStatus;
  provider: PaymentProvider;
}

export async function insertInitiatedPayment(
  client: PoolClient,
  bookingId: string,
  amount: number,
  provider: PaymentProvider = 'MOCK',
): Promise<PaymentRow> {
  const { rows } = await client.query<PaymentRow>(
    `INSERT INTO payments (booking_id, amount, status, provider) VALUES ($1, $2, 'INITIATED', $3)
     RETURNING id, booking_id, amount, status, provider`,
    [bookingId, amount, provider],
  );
  return rows[0]!;
}

/** Unlocked lookup, used only to find which booking to lock first (R3). */
export async function findBookingIdOfPayment(
  db: Queryable,
  paymentId: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{ booking_id: string }>(
    `SELECT booking_id FROM payments WHERE id = $1`,
    [paymentId],
  );
  return rows[0]?.booking_id;
}

export async function lockPayment(
  client: PoolClient,
  paymentId: string,
): Promise<PaymentRow | undefined> {
  const { rows } = await client.query<PaymentRow>(
    `SELECT id, booking_id, amount, status, provider FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  return rows[0];
}

/** Guarded transition. Returns false if the payment was not in the expected state. */
export async function transitionPayment(
  client: PoolClient,
  paymentId: string,
  from: PaymentStatus,
  to: PaymentStatus,
  refs: { providerReference?: string; refundReference?: string } = {},
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE payments
     SET status = $3,
         provider_reference = COALESCE(provider_reference, $4),
         refund_reference = COALESCE(refund_reference, $5),
         updated_at = now()
     WHERE id = $1 AND status = $2`,
    [paymentId, from, to, refs.providerReference ?? null, refs.refundReference ?? null],
  );
  if (rowCount === 1) logTransition(client, 'payment', paymentId, from, to);
  return rowCount === 1;
}
