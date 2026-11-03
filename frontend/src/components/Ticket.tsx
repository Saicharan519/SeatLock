import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { Booking } from '../lib/api';
import {
  bookingRef,
  categoryName,
  formatLongDay,
  formatMoney,
  formatTime,
  seatOrder,
} from '../lib/format';
import { Poster } from './Poster';

/** What the QR code says: enough for an usher's scanner to look the booking up. */
const qrPayload = (b: Booking) => `SEATLOCK:${b.id}:${b.seats.join(',')}`;

function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#231b14', light: '#00000000' },
    })
      .then(setSvg)
      .catch(() => setSvg(null));
  }, [text]);
  return (
    <div
      className="h-28 w-28 shrink-0 sm:h-32 sm:w-32"
      role="img"
      aria-label="Ticket QR code"
      // Generated locally by the qrcode library from our own booking data
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-[0.18em] text-ink-soft uppercase">{label}</div>
      <div className="mt-0.5 font-semibold">{children}</div>
    </div>
  );
}

/**
 * The confirmed ticket, printed on cream stock: the only light object on the dark site.
 * A perforated tear line separates the admission details from the QR stub.
 */
export function Ticket({ booking }: { booking: Booking }) {
  const { show } = booking;
  const seats = [...booking.seats].sort(seatOrder);
  const categories = [...new Set(booking.items.map((i) => categoryName(i.category)))];
  return (
    <article
      className="ticket-paper relative mx-auto max-w-md overflow-hidden rounded-3xl shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)]"
      aria-label={`Ticket for ${show.movie.title}`}
    >
      <div className="flex items-center justify-between bg-ink px-6 py-2.5 text-cream">
        <span className="font-display text-lg font-black tracking-widest uppercase">
          Seat<span className="text-marigold">Lock</span>
        </span>
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase">
          Admit {seats.length}
        </span>
      </div>

      <div className="p-6">
        <div className="flex gap-4">
          <Poster
            url={show.movie.posterUrl}
            title={show.movie.title}
            size="w185"
            className="w-20 shrink-0 rounded-lg ring-ink/10"
          />
          <div className="min-w-0">
            <h2 className="font-display text-3xl leading-[0.95] font-black tracking-wide uppercase">
              {show.movie.title}
            </h2>
            <div className="mt-2 text-xs text-ink-soft">
              {show.movie.certificate === 'UA' ? 'U/A' : show.movie.certificate} ·{' '}
              {show.movie.language}
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <Field label="Date">{formatLongDay(show.startsAt)}</Field>
          <Field label="Time">{formatTime(show.startsAt)}</Field>
          <Field label="Theatre">
            {show.theatre.name}
            <div className="text-xs font-normal text-ink-soft">{show.theatre.city}</div>
          </Field>
          <Field label="Screen">{show.screen.name}</Field>
          <Field label={`Seats · ${categories.join(', ')}`}>
            <span className="font-mono text-base">{seats.join('  ')}</span>
          </Field>
          <Field label="Paid">{formatMoney(booking.totalAmount)}</Field>
        </div>
      </div>

      {/* Tear line, with notches punched out of both edges */}
      <div className="relative h-6">
        <div className="absolute top-1/2 -left-3 h-6 w-6 -translate-y-1/2 rounded-full bg-night" />
        <div className="absolute top-1/2 -right-3 h-6 w-6 -translate-y-1/2 rounded-full bg-night" />
        <div className="absolute inset-x-6 top-1/2 border-t-2 border-dashed border-ink/20" />
      </div>

      <div className="flex items-center gap-5 p-6 pt-3">
        <QrCode text={qrPayload(booking)} />
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-[0.18em] text-ink-soft uppercase">
            Booking ID
          </div>
          <div className="font-mono text-2xl font-semibold tracking-wider">
            {bookingRef(booking.id)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            Show this code at the entrance. Arrive 15 minutes early.
          </p>
        </div>
      </div>
    </article>
  );
}
