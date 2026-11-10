import type { Pool } from 'pg';
import type { GatewayStore } from './app';

/** Keeps the mock gateway's charges and refunds in Postgres, so they survive a restart. */
export function createPgGatewayStore(pool: Pool): GatewayStore {
  return {
    async getCharge(paymentId) {
      const { rows } = await pool.query<{
        charge_id: string;
        amount: number;
        callback_url: string;
      }>(`SELECT charge_id, amount, callback_url FROM mock_gateway_charges WHERE payment_id = $1`, [
        paymentId,
      ]);
      const r = rows[0];
      return r && { chargeId: r.charge_id, amount: r.amount, callbackUrl: r.callback_url };
    },
    async saveCharge(paymentId, charge) {
      await pool.query(
        `INSERT INTO mock_gateway_charges (payment_id, charge_id, amount, callback_url)
         VALUES ($1, $2, $3, $4) ON CONFLICT (payment_id) DO NOTHING`,
        [paymentId, charge.chargeId, charge.amount, charge.callbackUrl],
      );
    },
    async getRefund(paymentId) {
      const { rows } = await pool.query<{ refund_id: string | null }>(
        `SELECT refund_id FROM mock_gateway_charges WHERE payment_id = $1`,
        [paymentId],
      );
      return rows[0]?.refund_id ?? undefined;
    },
    async saveRefund(paymentId, refundId) {
      await pool.query(
        `UPDATE mock_gateway_charges SET refund_id = $2 WHERE payment_id = $1 AND refund_id IS NULL`,
        [paymentId, refundId],
      );
    },
  };
}
