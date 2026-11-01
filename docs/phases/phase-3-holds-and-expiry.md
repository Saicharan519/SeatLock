# Phase 3: Holds and expiry (the core concurrency)

## What this phase is

The heart of the project: letting a user **hold** seats for 5 minutes while they pay, such that two people can never hold the same seat, even when 1,000 people click at the same instant. Plus the background **worker** that cleans up holds nobody paid for.

## The problem being solved

The naive way to hold a seat:

```
1. SELECT status FROM seats WHERE id = 7        -- "AVAILABLE"
2. (decide it's free)
3. UPDATE seats SET status = 'HELD' WHERE id = 7
```

Two requests can both run step 1 before either runs step 3. Both see "AVAILABLE", both hold the seat: a **double-booking**. This is a _read-then-write race_, the bug the whole project is built to prevent.

## How the hold works ([holdService.ts](../../apps/api/src/services/holdService.ts))

Everything below runs in **one transaction**. If any step fails, everything rolls back, including the idempotency key, so a failed hold leaves no trace.

1. **Idempotency key.** Insert the `Idempotency-Key` header value. If it already exists with the same request, return the stored response instead of doing the work again (see below).
2. **Validate.** The show exists and hasn't started; the 1–6 seat labels exist.
3. **The caller's own existing hold.** Look for the user's PENDING booking for this show and lock it (`FOR UPDATE`).
   - Still live → `409 ACTIVE_HOLD_EXISTS`.
   - Expired → read its seats and mark it EXPIRED; its seats are released in step 5.
4. **Insert the new PENDING booking** with `expires_at = now() + 5 minutes`.
5. **Lock all seats involved, in ascending id order.** That is the requested seats _plus_ the old hold's seats, in a single `SELECT ... ORDER BY id FOR UPDATE`. Then release the old hold's seats.
6. **Conditional claim**, one atomic statement:
   ```sql
   UPDATE seats SET status = 'HELD', booking_id = <new booking>
   WHERE id = ANY(<requested>)
     AND (status = 'AVAILABLE'
          OR (status = 'HELD' AND <its booking has expired>))
   ```
   The `WHERE` re-checks availability _at the moment of writing_, which closes the read-then-write gap.
7. **All-or-nothing (R8).** If fewer rows were updated than seats requested, throw `SEAT_UNAVAILABLE`, which rolls everything back. Nobody ever holds 2 of the 3 seats they asked for.
8. Insert `booking_items` at today's price, store the response under the idempotency key, commit.

## The key concepts

### Row locks (`SELECT ... FOR UPDATE`)

Locks the selected rows until the transaction ends. Another transaction that wants the same row **waits**. When it gets the lock, Postgres re-checks its `WHERE` against the newest version of the row. So the loser of a race sees the seat is now HELD, its claim updates 0 rows, and it gets `SEAT_UNAVAILABLE`.

### Why lock in id order (R2): deadlocks

User X wants seats {1, 9}; user Y wants {9, 1}. If X locks 1 then waits for 9, while Y locks 9 then waits for 1, each waits for the other forever: a **deadlock**. Postgres detects it and kills one transaction. If everyone locks in the same order (ascending id), the cycle is impossible: both go for seat 1 first, one waits, and the other finishes. That's why the old hold's seats join the _same_ lock set in step 5 instead of being locked separately. Locking them in a second pass would bring the deadlock back.

T2 checks this directly: after 200 overlapping random requests, Postgres' own deadlock counter (`pg_stat_database.deadlocks`) must not have moved.

### Global lock order (R3): booking → payment → seats

The same idea across tables. Every code path locks in this order, so no two paths can deadlock against each other. The hold locks the user's own booking first, then seats. Release locks booking, then payment, then seats.

### Guarded updates

`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`. The `AND status = 'PENDING'` means "only if nobody changed it first". If it updates 0 rows, someone else won the race, and the code handles that instead of overwriting their change.

### Idempotency ([idempotencyRepository.ts](../../apps/api/src/repositories/idempotencyRepository.ts))

A user double-clicks "Hold", or their phone retries after a network blip. Without protection, that's two bookings. The client sends an `Idempotency-Key` (any unique string, e.g. a UUID per click):

- Same key + same request → the stored response is replayed (with an `Idempotent-Replayed: true` header). No second booking.
- Same key + different request → `422 IDEMPOTENCY_KEY_REUSED`.
- **Concurrent** same-key requests: the second one's `INSERT` blocks on the unique index until the first commits, then sees the key and replays. The database serializes them; no application locking needed. T3 sends one key 20 times at once and gets exactly one booking.
- Only successes are stored. A failed hold rolls back its key, so retrying it runs again (it might succeed now).
- `request_hash` is SHA-256 of method, path and a canonical body (keys sorted; seat labels sorted), so `["A2","A1"]` and `["A1","A2"]` count as the same request.

### Stale-hold takeover (T19)

Priya's hold expired 10 seconds ago but the worker hasn't run yet. Rahul tries to hold her seat. The claim treats "HELD by an expired booking" as claimable, so Rahul gets it immediately instead of waiting for the worker. Priya's booking stays PENDING until the worker marks it EXPIRED; when it does, the release is guarded by `booking_id = Priya's booking`, so it doesn't touch the seat Rahul now owns.

## The expiry worker ([expireHolds.ts](../../apps/worker/src/jobs/expireHolds.ts), [index.ts](../../apps/worker/src/index.ts))

A separate Node process. Every 5 seconds:

```sql
SELECT id FROM bookings
WHERE status = 'PENDING' AND expires_at < now()
ORDER BY id LIMIT 100
FOR UPDATE SKIP LOCKED
```

Then it marks those bookings EXPIRED and releases their seats (locked in id order, guarded by `booking_id`), in batches of 100 until none are left.

- **`SKIP LOCKED`:** rows another transaction has locked are skipped instead of waited on. Two workers grab different batches, so running several is safe. A booking that a hold or (later) a payment webhook is busy with gets picked up on the next tick. One test runs two workers at once over 150 stale holds: each booking is expired exactly once.
- Ticks never overlap (the next one is scheduled only after the current one finishes), and a failing job is logged without killing the loop.

## Release (`POST /holds/:id/release`)

Gives up a hold: booking → CANCELLED, seats freed. Only the owner can do it (others get 404, which doesn't reveal that the booking exists). It's refused with `409 PAYMENT_IN_PROGRESS` if a payment is in flight. Releasing twice just returns the current state.

## What happened during this phase (worth knowing)

Two test failures taught real lessons:

1. **`ECONNREFUSED` in T1.** Desktop Windows caps the TCP accept queue at about 200 pending connections, so 1,000 simultaneous connects were refused before reaching the app. That's an OS limit, not a code bug, and Linux CI wouldn't hit it. Fix: the test client fires all 1,000 requests at once but sends them over 200 reused (keep-alive) connections. The server still sees 200 concurrent requests competing for 20 DB connections, which is the real stress.

2. **100 winners for 50 seats in T1.** This looked like a double-booking but wasn't. Tests use a 5-second TTL so expiry tests run fast, and on this machine the 1,000-request burst took more than 5 seconds. Late requests found early holds already **expired** and correctly took them over (the T19 behaviour). No seat ever had two _live_ holds. Fix: T1 runs with the production TTL (300 s), because it tests concurrency, not expiry. Lesson: when a concurrency test "fails", check whether the test's own assumptions (timing, TTL) still hold before concluding the code is wrong.

## Tests added

| Test               | Proves                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1**             | 1,000 users, 50 seats: exactly 50 `201`, 950 `SEAT_UNAVAILABLE`, nothing else (no 503s)                                                                                             |
| **T2**             | 200 random overlapping 1–4-seat requests: no partial holds, no shared seats, HELD count = live items, zero deadlocks                                                                |
| **T3** (hold part) | Same key ×20 concurrently → one booking, 19 replays                                                                                                                                 |
| **T4**             | Same key, different body → 422                                                                                                                                                      |
| **T5**             | After TTL the worker expires the hold and frees seats; another user can hold them                                                                                                   |
| **T19**            | Stale-hold takeover before the sweep; the sweep leaves the new owner alone                                                                                                          |
| +                  | Validation, all-or-nothing, failed holds leave no trace, one live hold per user (including two concurrent attempts), own stale hold replaced, release rules, two concurrent workers |

36 tests in total, all passing.

## Key takeaways

- The read-then-write race is closed by a conditional `UPDATE` whose row count must equal the seats requested.
- Locking seats in ascending id order makes the two-transaction deadlock cycle impossible.
- Correctness comes from row locks and guarded updates at READ COMMITTED, not from SERIALIZABLE isolation. Higher isolation would also be correct, but it aborts conflicting transactions that then need retrying; the locks make the outcome deterministic.
- Idempotency keys rely on the unique index to serialize concurrent duplicates.
- `SKIP LOCKED` lets several workers run safely in parallel.
- The "100 winners" result was a test failure that turned out to be correct behaviour (stale-hold takeover), not a double-booking.
