import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { AppError } from './errors';

const VALID_KEY = /^[\x21-\x7e]{1,100}$/;

/** Idempotency-Key is required on POST /holds and POST /bookings/:id/pay (PRD 9.7). */
export function requireIdempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key');
  if (!key) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  }
  if (!VALID_KEY.test(key)) {
    throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be 1-100 printable characters');
  }
  return key;
}

/** JSON with object keys sorted at every level, so key order never changes the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** request_hash = SHA-256 of method, path and canonical body. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}
