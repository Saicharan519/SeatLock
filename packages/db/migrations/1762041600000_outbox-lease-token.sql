-- Up Migration

-- A fresh random token is written every time a worker claims an event. The worker must
-- present it when recording the result. If its lease expired and another worker re-claimed
-- the event, the token no longer matches and the stale worker's result is ignored.
-- This is a "fencing token": it stops a slow worker overwriting a newer worker's outcome.
ALTER TABLE outbox_events ADD COLUMN lease_token uuid;

-- Down Migration

ALTER TABLE outbox_events DROP COLUMN lease_token;
