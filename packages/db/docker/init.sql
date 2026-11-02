-- Runs once when the Postgres volume is first created.
-- Integration tests, load tests and the race demo each use their own database,
-- so they never touch the app's data.
CREATE DATABASE seatlock_test OWNER seatlock;
CREATE DATABASE seatlock_load OWNER seatlock;
