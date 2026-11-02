import type { SeatStatus } from '../lib/api';

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const PER_ROW = 10;
const AISLE_AFTER = 5;

const STATUS_TEXT: Record<SeatStatus | 'SELECTED' | 'MINE', string> = {
  AVAILABLE: 'available',
  HELD: 'held by someone else',
  BOOKED: 'booked',
  SELECTED: 'selected',
  MINE: 'held by you',
};

/**
 * The auditorium plan. Seats someone else is holding are hatched ("pencilled in"), booked
 * seats are solid, your picks are marigold, and your own hold is hatched marigold.
 * Statuses come from the server and refresh live, so seats change as other people book.
 */
export function SeatGrid({
  seats,
  selected,
  mine,
  onToggle,
}: {
  seats: Map<string, SeatStatus>;
  selected: Set<string>;
  /** Seats in the user's own live hold */
  mine: Set<string>;
  onToggle: (label: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="mx-auto w-max px-2">
        {/* The screen: a shallow arc everyone faces */}
        <svg viewBox="0 0 400 34" className="mx-auto mb-1 w-full max-w-[460px]" aria-hidden="true">
          <path
            d="M10 28 Q200 -6 390 28"
            fill="none"
            stroke="var(--color-ink)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <div className="mb-8 text-center font-mono text-[11px] tracking-[0.3em] text-ink-soft uppercase">
          Screen
        </div>

        <div role="group" aria-label="Seats" className="space-y-2.5">
          {ROWS.map((row) => (
            <div key={row} className="flex items-center gap-1 sm:gap-2.5">
              <span className="w-4 text-center font-mono text-xs text-ink-soft" aria-hidden="true">
                {row}
              </span>
              {Array.from({ length: PER_ROW }, (_, i) => {
                const label = `${row}${i + 1}`;
                const status = seats.get(label) ?? 'AVAILABLE';
                const isSelected = selected.has(label);
                const isMine = status === 'HELD' && mine.has(label);
                const takeable = status === 'AVAILABLE';
                const look = isSelected
                  ? 'bg-marigold text-ink shadow-[inset_0_-3px_0_0_var(--color-marigold-deep)]'
                  : isMine
                    ? 'seat-mine text-ink'
                    : status === 'BOOKED'
                      ? 'bg-booked text-paper/40'
                      : status === 'HELD'
                        ? 'seat-held text-ink/50'
                        : 'bg-seat text-ink-soft hover:-translate-y-px hover:bg-seat-hover';
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onToggle(label)}
                    disabled={!takeable && !isSelected}
                    aria-pressed={isSelected}
                    aria-label={`Seat ${label}, ${STATUS_TEXT[isSelected ? 'SELECTED' : isMine ? 'MINE' : status]}`}
                    className={`seat grid h-6 w-6 place-items-center rounded-t-md rounded-b-sm font-mono text-[9px] sm:rounded-t-lg sm:text-[10px] disabled:cursor-not-allowed sm:h-9 sm:w-9 ${look} ${
                      i + 1 === AISLE_AFTER ? 'mr-3 sm:mr-6' : ''
                    }`}
                  >
                    {i + 1}
                  </button>
                );
              })}
              <span className="w-4 text-center font-mono text-xs text-ink-soft" aria-hidden="true">
                {row}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
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
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-ink-soft">
      {item('bg-seat', 'Available')}
      {item('bg-marigold', 'Your pick')}
      {item('seat-mine', 'Your hold')}
      {item('seat-held', 'Held by someone')}
      {item('bg-booked', 'Booked')}
    </div>
  );
}
