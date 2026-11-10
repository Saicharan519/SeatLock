-- Up Migration

-- Which gateway handles a payment. MOCK is SeatLock's own simulated gateway (deterministic
-- failure scenarios); CASHFREE is the real Cashfree gateway in its sandbox (test) mode.
-- Existing payments were all made through the mock.
ALTER TABLE payments
  ADD COLUMN provider text NOT NULL DEFAULT 'MOCK' CHECK (provider IN ('MOCK', 'CASHFREE'));

-- The reconciliation job looks for open Cashfree payments and refunds
CREATE INDEX payments_cashfree_open ON payments (created_at)
  WHERE provider = 'CASHFREE' AND status IN ('INITIATED', 'REFUND_REQUIRED');

-- Down Migration

DROP INDEX payments_cashfree_open;
ALTER TABLE payments DROP COLUMN provider;
