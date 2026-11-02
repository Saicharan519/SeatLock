import type { ReactNode } from 'react';
import type { Booking } from '../lib/api';
import { formatMoney, formatWhen } from '../lib/format';
import { Label } from './ui';

/**
 * A ticket: the booking on the left, a stub on the right, joined by a perforated edge.
 * The stub holds whatever matters most right now (the countdown, or the outcome).
 */
export function Ticket({ booking, stub }: { booking: Booking; stub: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-rule bg-card shadow-[0_1px_0_0_var(--color-rule)] sm:flex-row">
      <div className="flex-1 p-6">
        <Label>{booking.show.venue}</Label>
        <h1 className="font-display mt-1 text-2xl font-bold tracking-tight">
          {booking.show.title}
        </h1>
        <p className="text-sm text-ink-soft">{formatWhen(booking.show.startsAt)}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {booking.seats.map((s) => (
            <span
              key={s}
              className="rounded border border-ink/20 px-2 py-1 font-mono text-sm font-medium"
            >
              {s}
            </span>
          ))}
        </div>
        <div className="mt-6 flex items-baseline justify-between border-t border-dashed border-rule pt-4">
          <Label>Total</Label>
          <span className="font-mono text-xl font-semibold">
            {formatMoney(booking.totalAmount)}
          </span>
        </div>
      </div>
      <div
        className="perforation hidden w-4 shrink-0 border-l border-dashed border-rule sm:block"
        aria-hidden="true"
      />
      <div className="border-t border-dashed border-rule p-6 sm:w-56 sm:border-t-0">{stub}</div>
    </div>
  );
}
