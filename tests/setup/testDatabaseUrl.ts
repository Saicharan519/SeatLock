import 'dotenv/config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://seatlock:seatlock@localhost:5433/seatlock_test';
