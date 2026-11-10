-- Up Migration

-- The mock payment gateway's own records. A real gateway keeps its charges in its own
-- systems; the mock keeps them here so they survive a restart. Without this, a hosting
-- platform that stops idle processes (as free tiers do) would make the gateway forget every
-- charge, and later refunds would fail with "unknown payment".
--
-- Nothing in SeatLock itself reads this table: the API and worker still talk to the gateway
-- only over HTTP, exactly as they would to a real provider.
CREATE TABLE mock_gateway_charges (
  payment_id   uuid PRIMARY KEY,
  charge_id    text NOT NULL UNIQUE,
  amount       integer NOT NULL CHECK (amount > 0),
  callback_url text NOT NULL,
  refund_id    text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE mock_gateway_charges;
