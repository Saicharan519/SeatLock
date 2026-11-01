# Phase 5: Failure and edge paths

## What this phase is

The happy path (hold → pay → confirm) worked after Phase 4. This phase handles everything that goes wrong _around_ it: money arriving after the hold expired, customers cancelling, payments whose webhook never comes, and the webhook and the expiry worker colliding on the same booking. These are the scenarios that separate a demo from a system you'd trust with money.

## 1. Late payments: re-claim or refund (S6, PRD 9.3)

**The situation:** Priya holds A1 and A2 at 6:00, the hold expires at 6:05, and the "payment succeeded" webhook arrives at 6:07. She has been charged. Does she get the seats?

Phase 4 always refunded her (safe but harsh). Now the webhook tries to **re-claim all the seats at once** ([webhookService.ts](../../apps/api/src/services/webhookService.ts), `confirmLate`):

1. Lock the booking's seats in id order.
2. Count how many are claimable. A seat qualifies if it is:
   - AVAILABLE, or
   - still HELD by her own booking (the worker hasn't swept it yet), or
   - HELD by _someone else's_ hold that has **also** expired.

   A seat that is BOOKED, or under someone's **live** hold, does not qualify.

3. **All** claimable → book them all, booking EXPIRED → CONFIRMED, payment SUCCESS, `BookingConfirmed` event.
4. **Any** not claimable → touch nothing she doesn't own. Release whatever her booking still holds, booking EXPIRED, payment `REFUND_REQUIRED`, `RefundRequired` event.

Rules this guarantees:

- **Never steal:** a seat someone else holds legitimately (live hold) or has bought is never taken.
- **Never partial:** she gets every seat she paid for, or none plus a refund. Never 1 of 2.
- **Never ignore money:** if she can't have the seats, a refund is recorded in the same transaction.

It's the same **lock → verify → update** pattern as the normal confirmation: with the rows locked nothing can change between the count and the update, so there's nothing to roll back halfway and no savepoint is needed. And underneath it all, the `one_confirmed_per_seat` index would reject a double confirmation even if this logic had a bug.

## 2. Cancellation (S9, PRD 9.6)

`POST /bookings/:id/cancel`. In one transaction, locked booking → payment → seats (R3):

- Must be your booking (else 404), CONFIRMED (else 409), and the show not started (else 409).
- Booking → CANCELLED, seats → AVAILABLE, `booking_items.is_confirmed` → false, payment SUCCESS → `REFUND_REQUIRED`, and a `RefundRequired` outbox event.

Two details:

- **Clearing `is_confirmed`** is what lets someone else buy the seat afterwards. The old `booking_items` rows stay as history; the unique index only counts _confirmed_ items, so the next buyer's confirmation is allowed. A test proves this.
- **Naturally idempotent:** a double-click sends two cancels. The second waits for the first's booking lock, then sees CANCELLED and returns the current state. Seats are released once and one refund is queued (T16).

The actual money movement (calling the gateway's refund API, then REFUND_REQUIRED → REFUNDED) happens in Phase 6, when the worker processes the `RefundRequired` event.

## 3. Stuck-payment sweep ([sweepStuckPayments.ts](../../apps/worker/src/jobs/sweepStuckPayments.ts))

Recall from Phase 4: if the gateway call times out, we leave the payment INITIATED and wait for the webhook. What if the webhook **never** comes? The payment would be INITIATED forever.

The worker now marks payments INITIATED for over **15 minutes** as FAILED. Is that safe, given the customer might have been charged? Yes, because of a rule from Phase 4: a success webhook for a FAILED payment becomes `REFUND_REQUIRED`, never a silent no-op. **T17** walks through this exact story: ambiguous outcome → hold expires → sweep fails the payment → webhook finally arrives → refund owed, booking and seats untouched (no re-claim for a payment we already gave up on).

The sweep locks only payment rows (with `SKIP LOCKED`), never bookings, so it can't deadlock with the booking → payment lock order.

**Idempotency-key cleanup** ([cleanupIdempotencyKeys.ts](../../apps/worker/src/jobs/cleanupIdempotencyKeys.ts)): keys live 24 hours; the worker deletes expired ones in batches. The worker now runs three jobs each tick: expire holds, sweep payments, clean keys.

## 4. T14: the race between the webhook and the worker

The scariest timing: the hold expires at the same instant the payment webhook arrives. The worker wants to expire the booking, the webhook wants to confirm it. Three tests:

**a) The worker locks the booking first.** The test plays the worker by hand on its own database connection, so it can **pause** mid-transaction: lock the booking, fire the webhook, then _prove_ the webhook is blocked by checking Postgres's `pg_stat_activity` for a backend waiting on a lock. Then finish the worker's work (EXPIRED, seats released) and commit. The webhook wakes, sees EXPIRED, takes the late path, finds the seats free and confirms. One clean outcome.

**b) The webhook locks the booking first.** A test connection holds a lock on seat A1, so the webhook stalls _after_ locking the booking. Now run the real worker: thanks to `SKIP LOCKED` it skips the booking instead of waiting, and returns 0. Release the seat; the webhook confirms.

**c) Everything at once, 20 times.** Each round fires the webhook, the worker _and a rival user trying to hold A2_ simultaneously, with random jitter. Either outcome is legitimate. The test asserts that every round ends in exactly one of them, fully consistent:

- **We win:** booking CONFIRMED, payment SUCCESS, both seats BOOKED by us, rival got 409.
- **Rival wins:** booking EXPIRED, payment REFUND_REQUIRED, nothing of ours confirmed, rival holds A2, A1 free.

In measured runs both outcomes occur (about 2 and 18 out of 20), so both branches are really exercised.

"Forced interleaving" means making a specific ordering happen on purpose with locks, rather than hoping a random run hits it. Pausing one transaction while holding a lock is the standard technique.

## What happened during this phase (good interview stories)

1. **The race test found a 500.** Under the three-way race the webhook sometimes returned `500`. Debug logging (a new `TEST_LOG_LEVEL` switch for tests) showed `duplicate key violates unique constraint "payments_provider_ref_unique"`. The cause was **test data**: every hand-made event used the same charge id `ch_123`, so the second payment to record it hit the constraint. Real gateways issue a unique charge id per charge, so test events now derive the charge id from the payment id. The constraint itself did its job: one gateway charge can never be attached to two payments.
2. **SQL's three-valued logic.** A test computed "is this seat mine?" as `booking_id = my_id`. For a free seat `booking_id` is NULL, and `NULL = x` is **NULL**, not false. Fixed with `IS NOT DISTINCT FROM`, which treats NULL as a comparable value. A classic SQL gotcha.
3. **Checking that a test can fail both ways.** A test that accepts two outcomes is weak if only one ever happens. The outcome mix was measured once to confirm both branches run.

## Tests added (15, total now 69)

| Test    | Proves                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T8**  | Late success with seats free → confirmed (worker already expired it, and also before the worker ran)                                                |
| **T9**  | Late success, a seat taken → refund; no seat changed, no confirmed flag anywhere, no partial confirm; a still-PENDING booking releases what it held |
| +       | A seat under someone else's _expired_ hold is re-claimable, and the later sweep of that hold leaves it alone                                        |
| **T14** | Worker-first and webhook-first forced interleavings, plus 20 randomized three-way races: always one consistent outcome                              |
| **S9**  | Cancel → seats freed, flag cleared, refund owed and queued; the seats can be bought again                                                           |
| **T16** | Double cancel (concurrent + repeat) → released once, one refund event                                                                               |
| **T17** | Swept-to-FAILED payment that later succeeds → REFUND_REQUIRED, booking and seats untouched                                                          |
| +       | The sweep only touches payments INITIATED > 15 min; idempotency-key cleanup; cancel rules (owner, CONFIRMED only, before the show)                  |

## Interview talking points

- The late-payment policy: re-claim all or refund; never steal, never partial, never ignore money.
- Why the stuck-payment sweep is safe even if the customer was charged (FAILED + success → refund).
- Forced interleaving: how to _prove_ a race is handled (pause a transaction holding a lock, check `pg_stat_activity`), not just hope.
- `SKIP LOCKED` lets the worker step around in-flight work instead of queueing behind it.
- Why cancellation clears `is_confirmed` rather than deleting rows: history kept, invariant enforced.
- The NULL comparison gotcha, and the charge-id story (a test failure caused by unrealistic test data, caught by a constraint).
