export { createPool, type PoolOptions } from './pool';
export { withTransaction, afterCommit, isRetryable, RetryExhaustedError } from './transaction';
export {
  insertSeatsForShow,
  seatLabels,
  contendedOrder,
  SEAT_ROWS,
  SEATS_PER_ROW,
  lockSeatsInIdOrder,
  heldSeatIdsOfBookings,
  releaseHeldSeatsOfBookings,
  releaseLockedSeats,
} from './seats';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<import('pg').Pool, 'query'>;
