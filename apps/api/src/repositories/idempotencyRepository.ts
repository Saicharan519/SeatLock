import type { PoolClient } from 'pg';
import { AppError } from '../utils/errors';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyStart =
  { kind: 'new'; keyId: string } | { kind: 'replay'; response: StoredResponse };

interface KeyRow {
  id: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/**
 * Step 1 of every idempotent operation, inside its transaction.
 *
 * The INSERT takes the unique index entry on (user_id, key). A concurrent request with the
 * same key blocks on that entry until this transaction commits or rolls back:
 *  - commit   -> its INSERT hits the conflict, and it replays the stored response
 *  - rollback -> its INSERT succeeds, and it executes from scratch
 * So same-key requests serialize without any application-level locking.
 */
export async function beginIdempotent(
  client: PoolClient,
  input: { userId: string; key: string; endpoint: string; requestHash: string },
): Promise<IdempotencyStart> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING id`,
    [input.userId, input.key, input.endpoint, input.requestHash],
  );
  if (inserted.rows[0]) return { kind: 'new', keyId: inserted.rows[0].id };

  const { rows } = await client.query<KeyRow>(
    `SELECT id, request_hash, response_status, response_body
     FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [input.userId, input.key],
  );
  const existing = rows[0];
  // Deleted by the cleanup job between our INSERT and SELECT: treat as a transient conflict
  if (!existing) throw Object.assign(new Error('idempotency key vanished'), { code: '40001' });

  if (existing.request_hash !== input.requestHash) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request',
    );
  }
  if (existing.response_status === null) {
    // Cannot happen today: the response is stored in the same transaction as the key.
    throw new AppError('INVALID_STATE', 'A request with this Idempotency-Key is incomplete');
  }
  return {
    kind: 'replay',
    response: { status: existing.response_status, body: existing.response_body },
  };
}

/** Stores the response so retries replay it. Same transaction as the business change. */
export async function completeIdempotent(
  client: PoolClient,
  keyId: string,
  response: StoredResponse,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE id = $1`,
    [keyId, response.status, JSON.stringify(response.body)],
  );
}
