# Phase 12: Product data model

## What this phase is

v1 had one kind of thing to book: a "show" with a title, a venue string, one price and exactly 50 seats. A real cinema site needs films, theatres in different cities, screens of different shapes, showtimes, and seats that cost different amounts. This phase builds that model **underneath the booking engine without changing how booking works**: every locking rule, state machine and invariant from v1 is untouched, and every v1 test still passes.

## The model

```
Movie ──< Show >── Screen >── Theatre
            │
            ├──< show_prices (one price per seat category, per show)
            └──< Seat (one row per show and seat, as in v1) ── category ──> show_prices
                   └──< booking_items (price snapshot) >── Booking ── Payment
```

| Table         | What it holds                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `movies`      | Title, URL slug, synopsis, genres (array), language, running time, certificate (U/UA/A), rating, director, cast, poster and backdrop URLs, release date |
| `theatres`    | Name, city, address. Unique per (name, city): two cities can each have an "Aurora Multiplex"                                                            |
| `screens`     | A theatre's auditorium and its **seat layout** as JSON: rows, seats per row, each row's category, and where the aisles are                              |
| `shows`       | Now a showtime: a movie on a screen from `starts_at` to `ends_at` (running time + 15 minutes' cleaning)                                                 |
| `show_prices` | The price of each seat category for one show, e.g. CLASSIC ₹180, PRIME ₹250, RECLINER ₹450                                                              |
| `seats`       | Unchanged, plus `category`                                                                                                                              |

### Why seats are still one row per show

Seats could have been modelled per screen (a screen has 134 physical seats) with a separate "seat status per show" table. They stay one row per show and seat because that row **is the lock**: the hold locks seat rows in id order, claims them with a guarded update, and checks the row count. Keeping that row exactly as it was means the concurrency design and its 19 acceptance tests carry over unchanged. The layout lives on the screen; when a show is created, its seat rows are generated from the layout in row and seat-number order, so seat ids ascend in the same order the locks are taken.

### Prices: per category, per show, snapshotted per booking

- A screen's layout says which rows are CLASSIC, PRIME or RECLINER.
- `show_prices` says what each category costs **for that show**, so an evening show can cost more than a morning one on the same screen (the seed adds ₹30 to evening shows).
- When a hold is made, each seat's current price is read through a join and **copied into `booking_items.price`**. The booking total is the sum of those prices. Changing a price later affects only future holds; a test proves an existing booking keeps its price.

## New database rules

| Rule                                                                                                          | What it prevents                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `shows_no_overlap_per_screen`: `EXCLUDE USING gist (screen_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` | Two shows on one screen at the same time, even if two admins create them at the same moment. Back-to-back is allowed (ranges are half-open) |
| `seats_category_priced`: `(show_id, category)` references `show_prices`                                       | A seat in a category that has no price for its show                                                                                         |
| `shows_ends_after_start`                                                                                      | A show that ends before it starts                                                                                                           |
| `movies_slug_unique`, `movies_slug_format`                                                                    | Two movies at one URL; slugs that aren't URL-safe                                                                                           |

The overlap rule is an **exclusion constraint**, a Postgres feature that generalises `UNIQUE`: instead of "no two rows are equal", it says "no two rows have equal `screen_id` **and** overlapping time ranges". It needs the `btree_gist` extension so a GiST index can compare UUIDs with `=`. Like the v1 constraints, it holds even if application code has a bug or two requests race; the API turns the violation (`23P01`) into `409 SHOW_OVERLAP`.

## The migration

[`1793664000000_movies-theatres-showtimes.sql`](../../packages/db/migrations/1793664000000_movies-theatres-showtimes.sql) converts an existing v1 database rather than requiring a fresh one. Each old show becomes a movie (its title), a theatre (its venue, city "Unknown") and a screen with the v1 5 × 10 layout in one STANDARD category at its old price; then the old columns are dropped and the new constraints added. Existing bookings, payments and their prices are untouched.

Tested on a copy of the development database (16 bookings): up, down and up again, with the data intact each way.

## The API

Public:

| Endpoint                                      | Returns                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/movies?city=&genre=&language=&q=`   | Movies with `nowShowing`, `nextShowAt`, `showCount`, `minPrice` (within the city if given); genre and language filter values |
| `GET /api/movies/:slug`                       | Full movie detail (also accepts the id)                                                                                      |
| `GET /api/movies/:slug/showtimes?city=&date=` | One day's showtimes grouped by theatre, each with prices and live availability; `dates` lists every day that has shows       |
| `GET /api/cities`                             | Cities with upcoming shows                                                                                                   |
| `GET /api/shows/:id/seats`                    | The screen layout, the category prices, and every seat's live status and category                                            |

Admin (`POST /api/admin/movies`, `/theatres`, `/theatres/:id/screens`, `/shows`) validates layouts (unique single-letter rows, aisles inside rows, at most 600 seats) and requires prices for **exactly** the categories in the screen's layout.

### Days are counted in IST

"Shows on 4 November" must mean 4 November in India, not in UTC and not in the server's timezone. A 00:30 IST show on the 5th is 19:00 UTC on the 4th. Grouping is done in SQL with `(starts_at AT TIME ZONE 'Asia/Kolkata')::date`, configurable as `APP_TIMEZONE`. A test schedules shows at 23:30 and 00:30 IST and checks they land on different days; run with `APP_TIMEZONE=UTC`, that test fails, which confirms it tests something real.

## The demo seed

[`seedCatalog.ts`](../../packages/db/src/seedCatalog.ts):

- **14 well-known films** (Hollywood, Telugu, Hindi, Kannada) with posters and backdrops from TMDB's image CDN. Each image URL was downloaded and checked by eye before use: a URL returning 200 only proves that _an_ image exists. Synopses were written for this project; ratings are approximate.
- **7 fictional theatres in 4 cities** (Hyderabad, Bengaluru, Mumbai, Chennai) with **11 screens** in three layouts: standard (134 seats), IMAX (182) and compact (76), each with CLASSIC, PRIME and RECLINER rows. Rows skip the letter I, as many cinemas do.
- **Showtimes rolling forward**: four slots a day (09:30, 13:15, 17:00, 20:45 IST) for 7 days from the day the seed runs, skipping slots less than 15 minutes away. Re-running it only tops up missing future slots, so the demo never runs out of shows (v1's single show would have expired on 8 November). A slot that clashes with an admin-created show is skipped inside a savepoint.

| Seed run                        | Result                         |
| ------------------------------- | ------------------------------ |
| First run on a copy of dev data | 275 shows, 36,400 seats, 8.6 s |
| First run on the dev database   | 275 shows, 4.4 s               |
| Re-run                          | 0 shows added, 1.2 s           |

## Tests

| Change                                                                                                                                                                                                                                                                                                       | Why                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `createShow` test factory now builds a movie, theatre and screen on the **standard 50-seat layout**                                                                                                                                                                                                          | T1 and every other v1 test keep meaning "50 seats", with no edits to their bodies |
| shows.test: list and seat-map assertions read the new shape (`movie.title`, `prices`, `category`)                                                                                                                                                                                                            | The response shape changed, not the behaviour being tested                        |
| shows.test: the 3 `POST /admin/shows` tests **moved** to catalog.test and rewritten for the new body                                                                                                                                                                                                         | Creating a show now takes a movie, a screen and category prices                   |
| schema.test: the fixture show is created through the factory; the duplicate-label insert includes a category                                                                                                                                                                                                 | Seats now require a priced category                                               |
| **New** schema tests (2): unpriced category rejected; overlapping shows rejected, back-to-back allowed                                                                                                                                                                                                       | The two new database rules                                                        |
| **New** catalog.test (14): admin auth on every route, slugs, duplicates, layout validation, prices must match categories, overlap → 409 with nothing half-created, movie filters and facets, slug/id lookup, showtimes by theatre and IST day, cities, availability, mixed-category pricing, price snapshots | Phase 12 behaviour                                                                |
| **New** seed.test (2): only future shows, every seat priced, idempotent; tops up new days on a later run                                                                                                                                                                                                     | Fresh-install demo acceptance criterion                                           |

No test was deleted.

## Verification

| Check                                                                    | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full test suite                                                          | **118 / 118** (20 files, 141 s): the 102 carried over from v1 plus 16 new                                                                                                                     |
| Lint, typecheck, formatting; frontend build                              | Clean                                                                                                                                                                                         |
| Migration up / down / up on a copy of the dev database                   | Data intact each way                                                                                                                                                                          |
| Browser booking (dev mode, IMAX screen)                                  | A5 CLASSIC ₹310 + K5 RECLINER ₹680 = ₹990 held, paid, **confirmed**; database items 31000 + 68000 paise; My bookings correct; no console errors                                               |
| Race demo on the new model                                               | Naive told 532–562 customers they held one of 50 seats; SeatLock exactly 50                                                                                                                   |
| **Fresh install** (code copied outside OneDrive, new project and volume) | Healthy in 17 s; migrations + seed (275 shows) in 3.5 s; through nginx: 14 films in Bengaluru → Dune showtimes → A1 CLASSIC + K1 RECLINER held (₹720) → paid → **CONFIRMED**, no manual steps |

## What happened during this phase

1. **An aggregate inside a subquery.** The first draft of the movie list computed the minimum price with a subquery over `array_agg(sh.id)` from the enclosing aggregate. Postgres accepts outer aggregates in subqueries, but it was hard to read; joining `show_prices` and taking `min(price)` directly is clearer.
2. **The seat grid pushed the summary panel off screen.** The v1 seat page was built for 10-seat rows. With 18-seat IMAX rows, the CSS grid column grew to fit the seat map instead of scrolling it, because grid items default to `min-width: auto`. Adding `min-w-0` to the seat-map column fixed it. Found by booking in the browser, not by tests.
3. **The development database keeps a legacy entry.** The migrated v1 show appears as the movie "Interstellar (Re-release)" at "PVR Forum, Hall 3" in the city "Unknown". It only exists in databases that had v1 data; a fresh install doesn't have it.

## Key takeaways

- The booking engine stayed exactly as it was: seats are still one row per show and seat, locked in id order. The product model was added around it, and all v1 tests pass unchanged in substance.
- Prices live per category per show and are copied into each booking item at hold time, so history never changes.
- A Postgres exclusion constraint makes "no overlapping shows on a screen" a database guarantee, like the v1 "no double-booked seat" guarantee.
- Calendar days are computed in the business's timezone (IST) in SQL, and a test proves it by failing under UTC.
- The demo data rolls forward from the day it's seeded, so a fresh install is always bookable.
