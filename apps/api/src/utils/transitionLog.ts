import type { PoolClient } from 'pg';
import { afterCommit } from '@seatlock/db';
import type { Logger } from '@seatlock/shared';

let logger: Logger | undefined;

/** Set once at startup. Until then (and in most tests) transitions aren't logged. */
export function setTransitionLogger(l: Logger | undefined): void {
  logger = l;
}

/**
 * PRD observability: every booking and payment state change is logged with id, from, to.
 * Logged after COMMIT only, so a transition inside a transaction that rolls back (a failed
 * hold, a deadlock retry) never appears in the logs as if it had happened.
 */
export function logTransition(
  client: PoolClient,
  entity: 'booking' | 'payment',
  id: string,
  from: string,
  to: string,
): void {
  afterCommit(client, () => logger?.info({ entity, id, from, to }, 'state transition'));
}
