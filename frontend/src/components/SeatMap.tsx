import { useEffect, useRef } from 'react';
import type { LayoutRow, SeatStatus } from '../lib/api';
import { categoryName, formatMoney } from '../lib/format';

const STATUS_TEXT: Record<SeatStatus | 'SELECTED' | 'MINE', string> = {
  AVAILABLE: 'available',
  HELD: 'held by someone else',
  BOOKED: 'sold',
  SELECTED: 'selected',
  MINE: 'held by you',
};

/**
 * The auditorium, drawn from the screen's layout. The screen glows at the top and its
 * light falls across the seats. Rows are grouped into their price bands. Seats someone
 * else is holding are hatched ("pencilled in"), sold seats are dark, your picks are
 * marigold, and your own live hold is hatched marigold. Statuses refresh live.
 */
export function SeatMap({
  rows,
  priceOf,
  seats,
  selected,
  mine,
  onToggle,
}: {
  rows: LayoutRow[];
  /** category -> price in paise */
  priceOf: Map<string, number>;
  seats: Map<string, SeatStatus>;
  selected: Set<string>;
  mine: Set<string>;
  onToggle: (label: string) => void;
}) {
  // On a phone a wide screen doesn't fit: start scrolled to the middle, facing the screen.
  // Once only: the map re-renders every poll, and must not undo the user's own scrolling.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  // As on most booking sites, the screen is drawn at the top and row A sits nearest it
  return (
    <div
      ref={scroller}
      className="beam no-scrollbar overflow-x-auto rounded-3xl border border-line bg-night-2/40 px-3 pt-8 pb-10 sm:px-8"
    >
      <div className="mx-auto w-max min-w-full">
        {/* The screen */}
        <div className="mx-auto max-w-[560px]" aria-hidden="true">
          <svg viewBox="0 0 400 30" className="w-full">
            <defs>
              <linearGradient id="screen-glow" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#f4efe8" stopOpacity="0.9" />
                <stop offset="1" stopColor="#f4efe8" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M8 24 Q200 -4 392 24 L392 30 Q200 2 8 30 Z" fill="url(#screen-glow)" />
            <path
              d="M8 24 Q200 -4 392 24"
              fill="none"
              stroke="#f4efe8"
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 0 8px rgb(244 239 232 / 0.8))' }}
            />
          </svg>
          <div className="mt-1 text-center font-mono text-[10px] tracking-[0.5em] text-faint uppercase">
            Screen this way
          </div>
        </div>

        <div role="group" aria-label="Seats" className="mt-8">
          {rows.map((row, r) => {
            const bandStart = row.category !== rows[r - 1]?.category;
            return (
              <div key={row.label}>
                {bandStart && (
                  <div className="mt-6 mb-3 flex items-center gap-3 first:mt-0">
                    <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line-2" />
                    <span className="font-mono text-[11px] tracking-[0.25em] text-dim uppercase">
                      {categoryName(row.category)}{' '}
                      {/* No price in the admin's screen-layout preview: prices are per show */}
                      {priceOf.has(row.category) && (
                        <span className="text-screen">
                          {formatMoney(priceOf.get(row.category)!)}
                        </span>
                      )}
                    </span>
                    <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line-2" />
                  </div>
                )}
                <div className="flex items-center justify-center gap-1 py-[3px] sm:gap-1.5">
                  <RowLabel label={row.label} />
                  {Array.from({ length: row.seats }, (_, i) => {
                    const label = `${row.label}${i + 1}`;
                    const status = seats.get(label) ?? 'AVAILABLE';
                    const isSelected = selected.has(label);
                    const isMine = status === 'HELD' && mine.has(label);
                    const takeable = status === 'AVAILABLE';
                    const look = isSelected
                      ? 'bg-marigold text-night shadow-[0_0_14px_rgb(242_169_59/0.7)] -translate-y-0.5'
                      : isMine
                        ? 'seat-mine text-screen'
                        : status === 'BOOKED'
                          ? 'bg-seat-booked text-transparent ring-1 ring-inset ring-line'
                          : status === 'HELD'
                            ? 'seat-held text-transparent'
                            : 'bg-seat text-dim hover:-translate-y-0.5 hover:bg-seat-hover hover:text-screen';
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => onToggle(label)}
                        disabled={!takeable && !isSelected}
                        aria-pressed={isSelected}
                        aria-label={`Seat ${label}, ${categoryName(row.category)}, ${
                          STATUS_TEXT[isSelected ? 'SELECTED' : isMine ? 'MINE' : status]
                        }`}
                        className={`seat grid h-6 w-6 shrink-0 place-items-center rounded-t-lg rounded-b-[4px] font-mono text-[9px] font-semibold disabled:cursor-not-allowed sm:h-8 sm:w-8 sm:text-[10px] ${look} ${
                          row.aisleAfter.includes(i + 1) ? 'mr-3 sm:mr-6' : ''
                        }`}
                      >
                        {i + 1}
                      </button>
                    );
                  })}
                  <RowLabel label={row.label} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RowLabel({ label }: { label: string }) {
  return (
    <span className="w-5 shrink-0 text-center font-mono text-[11px] text-faint" aria-hidden="true">
      {label}
    </span>
  );
}

export function SeatLegend() {
  const item = (cls: string, text: string) => (
    <span className="flex items-center gap-2">
      <span
        className={`inline-block h-4 w-4 rounded-t-md rounded-b-sm ${cls}`}
        aria-hidden="true"
      />
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-dim">
      {item('bg-seat', 'Available')}
      {item('bg-marigold', 'Selected')}
      {item('seat-mine', 'Your hold')}
      {item('seat-held', 'Being booked')}
      {item('bg-seat-booked ring-1 ring-inset ring-line', 'Sold')}
    </div>
  );
}
