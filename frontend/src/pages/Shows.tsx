import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Label, Notice } from '../components/ui';
import { api, type Show } from '../lib/api';
import { formatMoney } from '../lib/format';

const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric' });
const month = new Intl.DateTimeFormat('en-IN', { month: 'short' });
const time = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export function Shows() {
  const [shows, setShows] = useState<Show[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .shows()
      .then(({ shows }) => setShows(shows))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div>
      <h1 className="font-display mb-8 text-3xl font-bold tracking-tight">Now booking</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {shows?.length === 0 && (
        <Notice>No upcoming shows yet. New shows appear here as soon as they’re scheduled.</Notice>
      )}
      <ul className="space-y-3">
        {shows?.map((s) => {
          const at = new Date(s.startsAt);
          return (
            <li key={s.id}>
              <Link
                to={`/shows/${s.id}`}
                className="group flex items-stretch overflow-hidden rounded-lg border border-rule bg-card transition-shadow hover:shadow-[0_2px_0_0_var(--color-ink)]"
              >
                <div className="flex w-20 shrink-0 flex-col items-center justify-center border-r border-dashed border-rule py-4">
                  <span className="font-display text-3xl leading-none font-bold">
                    {day.format(at)}
                  </span>
                  <span className="font-mono text-xs tracking-widest text-ink-soft uppercase">
                    {month.format(at)}
                  </span>
                </div>
                <div className="flex flex-1 flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <div className="font-display text-lg font-semibold">{s.title}</div>
                    <div className="text-sm text-ink-soft">
                      {s.venue} · {time.format(at)}
                    </div>
                  </div>
                  <div className="text-right">
                    <Label>Per seat</Label>
                    <div className="font-mono font-medium">{formatMoney(s.pricePerSeat)}</div>
                  </div>
                </div>
                <div className="flex items-center bg-ink px-4 text-sm font-semibold text-paper transition-colors group-hover:bg-booked">
                  Choose seats →
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
