export { createPool, type PoolOptions } from './pool';
export { withTransaction, afterCommit, isRetryable, RetryExhaustedError } from './transaction';
export {
  lockSeatsInIdOrder,
  heldSeatIdsOfBookings,
  releaseHeldSeatsOfBookings,
  releaseLockedSeats,
} from './seats';
export {
  type LayoutRow,
  type ScreenLayout,
  type LayoutSeat,
  layoutSeats,
  layoutCategories,
  STANDARD_LAYOUT,
  seatLabels,
  contendedOrder,
  insertShowWithSeats,
  insertPricesAndSeats,
  createStandardShow,
} from './catalog';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<import('pg').Pool, 'query'>;
