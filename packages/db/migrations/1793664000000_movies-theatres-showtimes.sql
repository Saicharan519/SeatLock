-- Up Migration

-- v2 data model: Movie -> Theatre -> Screen -> Show -> Seat -> Booking -> Payment.
--
-- A show becomes a showtime: a movie on a screen at a time. Seats stay one row per show
-- and seat (so every locking rule is unchanged); each seat now has a category, and each
-- show prices its categories in show_prices. booking_items.price already snapshots the
-- price at hold time, so a later price change never alters an existing booking.

-- For the "no two shows overlap on one screen" exclusion constraint (= on uuid in GiST)
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE movies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL,
  title            text NOT NULL,
  synopsis         text NOT NULL DEFAULT '',
  genres           text[] NOT NULL DEFAULT '{}',
  language         text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  certificate      text NOT NULL CHECK (certificate IN ('U', 'UA', 'A')),
  rating           numeric(3, 1) CHECK (rating BETWEEN 0 AND 10),
  director         text NOT NULL DEFAULT '',
  cast_members     text[] NOT NULL DEFAULT '{}',
  poster_url       text,
  backdrop_url     text,
  release_date     date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movies_slug_unique UNIQUE (slug),
  CONSTRAINT movies_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

-- Genre filter: genres @> ARRAY['Action']
CREATE INDEX movies_genres ON movies USING gin (genres);

CREATE TABLE theatres (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  city       text NOT NULL,
  address    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theatres_name_city UNIQUE (name, city)
);

CREATE INDEX theatres_city ON theatres (city);

-- layout: {"rows": [{"label": "A", "category": "CLASSIC", "seats": 12, "aisleAfter": [4, 8]}]}
-- Validated by the API when a screen is created; seat_count is derived from it.
CREATE TABLE screens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theatre_id uuid NOT NULL REFERENCES theatres (id),
  name       text NOT NULL,
  layout     jsonb NOT NULL,
  seat_count integer NOT NULL CHECK (seat_count BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT screens_theatre_name UNIQUE (theatre_id, name)
);

ALTER TABLE shows
  ADD COLUMN movie_id  uuid REFERENCES movies (id),
  ADD COLUMN screen_id uuid REFERENCES screens (id),
  ADD COLUMN ends_at   timestamptz;

-- Price per seat category, per show. Category names are UPPER_SNAKE (CLASSIC, RECLINER).
CREATE TABLE show_prices (
  show_id  uuid NOT NULL REFERENCES shows (id),
  category text NOT NULL CHECK (category ~ '^[A-Z][A-Z_]{1,19}$'),
  price    integer NOT NULL CHECK (price > 0),
  PRIMARY KEY (show_id, category)
);

ALTER TABLE seats ADD COLUMN category text;

-- Backfill existing v1 shows: each becomes a movie (its title and description) on
-- "Screen 1" of a theatre named after its venue, with the v1 5 x 10 layout in a single
-- STANDARD category at its old price. Assumes a 3-hour running time.
DO $$
DECLARE
  s record;
  v_movie uuid;
  v_theatre uuid;
  v_screen uuid;
BEGIN
  FOR s IN SELECT * FROM shows ORDER BY created_at, id LOOP
    INSERT INTO movies (slug, title, synopsis, language, duration_minutes, certificate, release_date)
    VALUES (
      'legacy-' || left(s.id::text, 8),
      s.title, s.description, 'English', 180, 'UA', s.starts_at::date
    )
    RETURNING id INTO v_movie;

    INSERT INTO theatres (name, city) VALUES (s.venue, 'Unknown')
    ON CONFLICT (name, city) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_theatre;

    INSERT INTO screens (theatre_id, name, layout, seat_count)
    VALUES (
      v_theatre,
      'Screen ' || left(s.id::text, 8),
      '{"rows": [
         {"label": "A", "category": "STANDARD", "seats": 10, "aisleAfter": []},
         {"label": "B", "category": "STANDARD", "seats": 10, "aisleAfter": []},
         {"label": "C", "category": "STANDARD", "seats": 10, "aisleAfter": []},
         {"label": "D", "category": "STANDARD", "seats": 10, "aisleAfter": []},
         {"label": "E", "category": "STANDARD", "seats": 10, "aisleAfter": []}
       ]}'::jsonb,
      50
    )
    RETURNING id INTO v_screen;

    UPDATE shows
    SET movie_id = v_movie, screen_id = v_screen, ends_at = starts_at + interval '3 hours'
    WHERE id = s.id;

    INSERT INTO show_prices (show_id, category, price) VALUES (s.id, 'STANDARD', s.price_per_seat);
  END LOOP;
END $$;

UPDATE seats SET category = 'STANDARD' WHERE category IS NULL;

ALTER TABLE shows
  ALTER COLUMN movie_id SET NOT NULL,
  ALTER COLUMN screen_id SET NOT NULL,
  ALTER COLUMN ends_at SET NOT NULL,
  DROP COLUMN title,
  DROP COLUMN description,
  DROP COLUMN venue,
  DROP COLUMN price_per_seat,
  ADD CONSTRAINT shows_ends_after_start CHECK (ends_at > starts_at),
  -- A screen can't run two shows at once. Ranges are half-open, so back-to-back is fine.
  ADD CONSTRAINT shows_no_overlap_per_screen
    EXCLUDE USING gist (screen_id WITH =, tstzrange(starts_at, ends_at) WITH &&);

CREATE INDEX shows_movie_starts ON shows (movie_id, starts_at);

ALTER TABLE seats
  ALTER COLUMN category SET NOT NULL,
  -- Every seat's category has a price for its show
  ADD CONSTRAINT seats_category_priced
    FOREIGN KEY (show_id, category) REFERENCES show_prices (show_id, category);

-- Down Migration

ALTER TABLE shows
  ADD COLUMN title text,
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN venue text,
  ADD COLUMN price_per_seat integer;

UPDATE shows sh
SET title = m.title,
    description = m.synopsis,
    venue = t.name || ', ' || sc.name,
    price_per_seat = (SELECT min(price) FROM show_prices p WHERE p.show_id = sh.id)
FROM movies m, screens sc, theatres t
WHERE m.id = sh.movie_id AND sc.id = sh.screen_id AND t.id = sc.theatre_id;

ALTER TABLE seats DROP CONSTRAINT seats_category_priced;
ALTER TABLE seats DROP COLUMN category;

DROP INDEX shows_movie_starts;
ALTER TABLE shows
  DROP CONSTRAINT shows_no_overlap_per_screen,
  DROP CONSTRAINT shows_ends_after_start,
  DROP COLUMN movie_id,
  DROP COLUMN screen_id,
  DROP COLUMN ends_at,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN venue SET NOT NULL,
  ALTER COLUMN price_per_seat SET NOT NULL,
  ADD CONSTRAINT shows_price_per_seat_check CHECK (price_per_seat > 0);

DROP TABLE show_prices;
DROP TABLE screens;
DROP TABLE theatres;
DROP TABLE movies;
