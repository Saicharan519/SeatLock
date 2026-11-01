# Phase 6: Transactional outbox and consumers

## What this phase is

Since Phase 4, every important state change has written an **event row** into `outbox_events` in the same transaction: `BookingConfirmed` when a booking is confirmed, `RefundRequired` when money must go back. Nothing read those rows yet. This phase builds the worker side that **delivers** them: a notification for every confirmed booking, and a real refund call to the payment gateway for every refund owed. It also handles the hard part: a worker crashing halfway through.

## Why an outbox at all

The naive way to send a confirmation:

```
COMMIT booking            <- booking is now CONFIRMED
send notification         <- if the server dies right here, the customer never hears
```

There's a gap between the commit and the send. A crash in that gap loses the message forever, and you can't fix it by sending first (then a rollback would announce a booking that doesn't exist). The **transactional outbox** removes the gap: the event is just another row written in the _same_ transaction as the booking. Either both commit or neither does. A separate process delivers events afterwards, and if it crashes, the event is still sitting there waiting (S5).

## How delivery works ([processOutbox.ts](../../apps/worker/src/outbox/processOutbox.ts))

Every worker tick:

**1. Claim (transaction 1, committed immediately).** Pick up to 20 due events with `FOR UPDATE SKIP LOCKED`, mark them `PROCESSING`, give each a **lease** (`locked_until = now() + 60 s`) and a fresh random **lease token**. "Due" means:

- `PENDING` and its retry time has come, or
- `PROCESSING` but its lease **expired**: the worker that claimed it crashed or stalled.

**2. Run the consumer, outside any transaction** (rule R7), with a 10-second timeout. This may call external services (the gateway).

**3. Record the result (transaction 2).**

- Success → `PUBLISHED`.
- Failure → back to `PENDING` with `retry_count + 1`, the error saved in `last_error`, and the next try delayed by **exponential backoff**: 1 s, 2 s, 4 s, 8 s ... (capped at 5 minutes).
- After **8 failed attempts** → `FAILED`, parked for a human to inspect (the admin endpoint comes in Phase 7).

Why not hold the row lock while the handler runs, instead of a lease? That would keep a database transaction open across an HTTP call: locks held for seconds, and a connection tied up per event. The lease gives the same "only one worker at a time" protection with no open transaction.

### Leases and the crashed worker (T11)

A worker that dies mid-handler never records a result. Its event stays `PROCESSING`, but only until the lease runs out; then any worker can re-claim it. So nothing is ever stuck forever. The flip side: **the handler may run twice** (once in the dead worker, once in the new one). That's why delivery is **at-least-once**, and every consumer must be **idempotent**.

### The fencing token (decision beyond the PRD)

A subtle case: worker A isn't dead, just slow. Its lease expires, worker B re-claims the event and finishes it. Then A wakes up and tries to record _its_ result, possibly a failure, overwriting B's success. To stop this, every claim writes a fresh random `lease_token`, and recording a result requires `WHERE lease_token = <my token>`. A's token is stale, so its update changes nothing. This is called a **fencing token**. (The PRD only guarded on `status = 'PROCESSING'`, which B's claim also satisfies.)

### Poison events

An event whose handler crashes the whole process would be re-claimed after every lease expiry, forever. So re-claiming an expired lease **counts as a failed attempt**. After 8, the event goes to `FAILED` without running again.

### Why batches are small and run concurrently

A batch's handlers run **in parallel**, so the whole batch finishes within one handler timeout (10 s), far inside the lease (60 s). A batch of 100 run one by one could take longer than its own lease, and another worker would start re-claiming events the first is still working through. The worker also refuses to start if the lease isn't longer than the handler timeout.

## The consumers ([consumers/index.ts](../../apps/worker/src/consumers/index.ts))

| Event              | Side effect                                                                               | Why it's idempotent                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BookingConfirmed` | Insert a row into `notifications` (stands in for an email or SMS, which the PRD excludes) | `notifications.event_id` is UNIQUE: a second run hits the constraint and inserts nothing (`ON CONFLICT DO NOTHING`) |
| `RefundRequired`   | Call the gateway's `POST /refunds`                                                        | The gateway dedupes refunds by payment id: a second call returns the original refund, no second payout              |

The refund completes asynchronously: the gateway sends a signed `refund.succeeded` webhook, and the existing Phase 4 handler moves the payment `REFUND_REQUIRED → REFUNDED`. So the full S9 chain is:

```
cancel -> RefundRequired row (same txn) -> worker claims -> gateway /refunds
       -> refund.succeeded webhook -> payment REFUNDED
```

## Other changes

- The **gateway client moved to the shared package**, since the worker now needs it too (for refunds).
- **New migration:** `outbox_events.lease_token`.
- The worker now runs **four jobs** each tick: process the outbox, expire holds, sweep stuck payments, clean up keys.
- New worker settings: `OUTBOX_LEASE_SECONDS` (60), `OUTBOX_HANDLER_TIMEOUT_MS` (10 000), `OUTBOX_MAX_ATTEMPTS` (8), `OUTBOX_BACKOFF_BASE_MS` (1000), and `GATEWAY_URL` / `API_PUBLIC_URL` for refunds.

## What happened during this phase

1. **T11 kills a real process.** Instead of simulating a crash, the test starts a separate worker **OS process** that runs the real notification consumer, prints a marker after the side effect, and then hangs. The test kills it with `SIGKILL` (no cleanup, like a crash or out-of-memory kill), checks that a healthy worker can't touch the event while the dead worker's lease is still valid, waits for the lease to expire, and runs a healthy worker. Result: event re-claimed (`retry_count = 1`), consumer ran a second time, and still **exactly one** notification thanks to the unique constraint.
2. **"One attempt per tick" surfaced in a test.** A test expected an always-failing event to reach FAILED in a single tick when the backoff was zero. It didn't: a tick claims due events once and stops when a batch comes back short, so a failed event waits for the next tick. That's the intended behaviour (no hot retry loop inside a tick), and the test was corrected to run three ticks.
3. **Shared mock state between tests.** A refund test counted all refunds the in-memory gateway had seen, including earlier tests'. The meaningful check was per payment: the gateway now counts refund calls per payment, and the test asserts **2 calls in, 1 refund out**.
4. **Real-process smoke test.** API, gateway and worker were started as three separate programs and a booking taken through its whole life with `curl`: CONFIRMED → notification delivered → CANCELLED → refund sent → **REFUNDED**, all driven by the worker.

## Tests added (13, total now 82)

| Test                  | Proves                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T11**               | A worker killed mid-handler (real `SIGKILL`): lease expires, event re-claimed, exactly one notification                                                                                                                                                          |
| **T12** (outbox side) | Two workers over 60 events: each handled exactly once, both workers participated                                                                                                                                                                                 |
| **S5**                | An event committed with the booking is delivered when a worker next runs                                                                                                                                                                                         |
| **S9** (complete)     | Cancel → refund call → refund webhook → REFUNDED, end to end over HTTP                                                                                                                                                                                           |
| +                     | Consumer idempotency (notification and refund: 2 calls, 1 refund), retry with backoff then success, exponential delays (10/20/40 s), FAILED after max attempts, handler timeout, unknown event type, fencing token, poison event, late-payment refund end to end |

## Key takeaways

- The transactional outbox closes the gap between "committed" and "announced": the event commits atomically with the state change.
- Leases recover from crashed workers without holding a transaction open during external calls.
- Delivery is at-least-once, so consumers are idempotent, here through a unique constraint and the gateway's per-payment dedupe.
- A fencing token stops a slow worker whose lease expired from overwriting a newer worker's result.
- Counting expired leases as attempts keeps a poison event from looping forever.
- Exactly-once delivery is never claimed; at-least-once plus idempotent consumers gives the same visible result.
