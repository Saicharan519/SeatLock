-- Up Migration

-- Money is integer paise. All timestamps are timestamptz.
-- Statuses are text + CHECK rather than Postgres enums so adding a state is a one-line migration.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE shows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  venue          text NOT NULL,
  starts_at      timestamptz NOT NULL,
  price_per_seat integer NOT NULL CHECK (price_per_seat > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shows_starts_at ON shows (starts_at);

CREATE TABLE bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  show_id      uuid NOT NULL REFERENCES shows (id),
  status       text NOT NULL
               CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  total_amount integer NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  -- The single expiry authority. Seats carry no held_until.
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One active hold per user per show (anti-hoarding)
CREATE UNIQUE INDEX one_pending_per_user_show
  ON bookings (user_id, show_id) WHERE status = 'PENDING';

-- Expiry worker scan
CREATE INDEX bookings_pending_expiry ON bookings (expires_at) WHERE status = 'PENDING';

-- GET /bookings/me
CREATE INDEX bookings_user_created ON bookings (user_id, created_at DESC);

CREATE TABLE seats (
  id         bigserial PRIMARY KEY,
  show_id    uuid NOT NULL REFERENCES shows (id),
  seat_label text NOT NULL,
  status     text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
  booking_id uuid REFERENCES bookings (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Seat ownership is consistent with status
  CONSTRAINT seat_status_owner CHECK ((status = 'AVAILABLE') = (booking_id IS NULL)),
  CONSTRAINT seats_show_label UNIQUE (show_id, seat_label)
);

-- Releases are guarded by booking_id
CREATE INDEX seats_booking ON seats (booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE booking_items (
  id           bigserial PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES bookings (id),
  seat_id      bigint NOT NULL REFERENCES seats (id),
  price        integer NOT NULL CHECK (price > 0),
  is_confirmed boolean NOT NULL DEFAULT false,
  CONSTRAINT items_unique UNIQUE (booking_id, seat_id)
);

-- The core invariant: a seat can be in at most one CONFIRMED booking
CREATE UNIQUE INDEX one_confirmed_per_seat ON booking_items (seat_id) WHERE is_confirmed;

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings (id),
  amount             integer NOT NULL CHECK (amount > 0),
  status             text NOT NULL
                     CHECK (status IN ('INITIATED', 'SUCCESS', 'FAILED', 'REFUND_REQUIRED', 'REFUNDED')),
  provider_reference text,
  refund_reference   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_booking_unique UNIQUE (booking_id),
  CONSTRAINT payments_provider_ref_unique UNIQUE (provider_reference)
);

-- Stuck-payment sweep
CREATE INDEX payments_initiated ON payments (created_at) WHERE status = 'INITIATED';

CREATE TABLE idempotency_keys (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id),
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  -- Concurrent same-key requests serialize on this. A key reused on another
  -- endpoint has a different request hash, so it gets 422.
  CONSTRAINT idempotency_user_key UNIQUE (user_id, key)
);

CREATE INDEX idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE webhook_events (
  provider_event_id text PRIMARY KEY,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  retry_count     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);

CREATE INDEX outbox_due ON outbox_events (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX outbox_leases ON outbox_events (locked_until) WHERE status = 'PROCESSING';

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  -- Unique so a duplicate outbox delivery hits the constraint and is ignored
  event_id   bigint NOT NULL REFERENCES outbox_events (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_event_unique UNIQUE (event_id)
);

-- Down Migration

DROP TABLE notifications;
DROP TABLE outbox_events;
DROP TABLE webhook_events;
DROP TABLE idempotency_keys;
DROP TABLE payments;
DROP TABLE booking_items;
DROP TABLE seats;
DROP TABLE bookings;
DROP TABLE shows;
DROP TABLE users;
