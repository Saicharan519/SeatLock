-- Runs once when the Postgres volume is first created.
-- Integration tests use their own database so they never touch dev data.
CREATE DATABASE seatlock_test OWNER seatlock;
