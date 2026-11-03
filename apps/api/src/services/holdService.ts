import type { Pool } from 'pg';
import {
  heldSeatIdsOfBookings,
  lockSeatsInIdOrder,
  releaseHeldSeatsOfBookings,
  releaseLockedSeats,
  withTransaction,
} from '@seatlock/db';
import type { ApiConfig } from '../config/env';
import * as bookings from '../repositories/bookingRepository';
import {
  beginIdempotent,
  completeIdempotent,
  type StoredResponse,
} from '../repositories/idempotencyRepository';
import { AppError } from '../utils/errors';
import { hashRequest } from '../utils/idempotency';

const HOLD_ENDPOINT = 'POST /api/holds';

export function createHoldService(pool: Pool, config: ApiConfig) {
  return {
    /**
     * PRD 9.1. One transaction; any failure rolls everything back, including the
     * idempotency key, so a failed hold leaves no trace and a retry re-executes.
     * Returns the stored response for replays.
     */
    async hold(
      userId: string,
      idempotencyKey: string,
      input: { showId: string; seats: string[] },
    ): Promise<StoredResponse & { replayed: boolean }> {
      const requestHash = hashRequest('POST', '/api/holds', input);

      return withTransaction(pool, async (client) => {
        // 1. Idempotency
        const idem = await beginIdempotent(client, {
          userId,
          key: idempotencyKey,
          endpoint: HOLD_ENDPOINT,
          requestHash,
        });
        if (idem.kind === 'replay') return { ...idem.response, replayed: true };

        // 2. Validate show and seat labels
        const show = await bookings.findShowForHold(client, input.showId);
        if (!show) throw new AppError('NOT_FOUND', 'Show not found');
        if (!show.upcoming) throw new AppError('INVALID_STATE', 'Show has already started');

        const seats = await bookings.findSeatsByLabels(client, input.showId, input.seats);
        if (seats.length !== input.seats.length) {
          const known = new Set(seats.map((s) => s.seat_label));
          const unknown = input.seats.filter((l) => !known.has(l));
          throw new AppError('VALIDATION_ERROR', `Unknown seats: ${unknown.join(', ')}`);
        }
        const requestedIds = seats.map((s) => s.id);
        // Each seat at its category price; booking_items keeps these as the price snapshot
        const totalAmount = seats.reduce((sum, s) => sum + s.price, 0);

        // 3. The caller's own PENDING booking for this show (locked: booking comes first, R3)
        const existing = await bookings.lockPendingBookingOfUser(client, userId, input.showId);
        if (existing?.live) {
          throw new AppError('ACTIVE_HOLD_EXISTS', 'You already have an active hold for this show');
        }
        let staleSeatIds: string[] = [];
        if (existing) {
          // Stale: read its seats now so they join the single lock set in step 5
          staleSeatIds = await heldSeatIdsOfBookings(client, [existing.id]);
          await bookings.transitionBooking(client, existing.id, 'PENDING', 'EXPIRED');
        }

        // 4. The new PENDING booking
        let booking: { id: string; expires_at: Date };
        try {
          booking = await bookings.insertPendingBooking(client, {
            userId,
            showId: input.showId,
            totalAmount,
            ttlSeconds: config.HOLD_TTL_SECONDS,
          });
        } catch (err) {
          // A concurrent hold by the same user (different key) committed first
          if ((err as { constraint?: string }).constraint === 'one_pending_per_user_show') {
            throw new AppError(
              'ACTIVE_HOLD_EXISTS',
              'You already have an active hold for this show',
            );
          }
          throw err;
        }

        // 5. ONE lock set: requested seats plus the stale hold's seats, ascending id (R2)
        await lockSeatsInIdOrder(client, [...new Set([...requestedIds, ...staleSeatIds])]);
        if (existing) await releaseLockedSeats(client, [existing.id]);

        // 6-7. Conditional claim, all-or-nothing (R8)
        const claimed = await bookings.claimSeats(client, requestedIds, booking.id);
        if (claimed !== requestedIds.length) {
          throw new AppError('SEAT_UNAVAILABLE', 'One or more seats are no longer available');
        }

        // 8. Items at the hold-time price, store the response, commit
        await bookings.insertBookingItems(client, booking.id, seats);
        const response: StoredResponse = {
          status: 201,
          body: {
            bookingId: booking.id,
            status: 'PENDING',
            seats: seats.map((s) => s.seat_label),
            totalAmount,
            expiresAt: booking.expires_at.toISOString(),
          },
        };
        await completeIdempotent(client, idem.keyId, response);
        return { ...response, replayed: false };
      });
    },

    /** Gives up a PENDING hold. Lock order booking -> payment -> seats (R3). */
    async release(userId: string, bookingId: string) {
      return withTransaction(pool, async (client) => {
        const booking = await bookings.lockBookingOfUser(client, bookingId, userId);
        if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
        // Releasing twice is harmless: report the current state
        if (booking.status === 'CANCELLED') return { bookingId, status: 'CANCELLED' as const };
        if (booking.status !== 'PENDING') {
          throw new AppError('INVALID_STATE', `Cannot release a ${booking.status} booking`);
        }

        const payment = await bookings.lockPaymentOfBooking(client, bookingId);
        if (payment?.status === 'INITIATED') {
          throw new AppError('PAYMENT_IN_PROGRESS', 'A payment for this booking is in progress');
        }

        await bookings.transitionBooking(client, bookingId, 'PENDING', 'CANCELLED');
        await releaseHeldSeatsOfBookings(client, [bookingId]);
        return { bookingId, status: 'CANCELLED' as const };
      });
    },
  };
}

export type HoldService = ReturnType<typeof createHoldService>;
