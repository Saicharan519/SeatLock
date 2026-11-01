export { createPool, type PoolOptions } from './pool';
export { withTransaction, isRetryable, RetryExhaustedError } from './transaction';
export { insertSeatsForShow, seatLabels, SEAT_ROWS, SEATS_PER_ROW } from './seats';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<import('pg').Pool, 'query'>;
