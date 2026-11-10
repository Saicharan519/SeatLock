import { useState } from 'react';
import { Link } from 'react-router';
import { Notice, Skeleton, StatusPill, bookingPill } from '../../components/ui';
import { api, type AdminOverview } from '../../lib/api';
import { bookingRef, dayParts, formatMoney, formatWhen } from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { PageHeader, Panel, StatTile } from './kit';

const percent = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Seven days of confirmed revenue, one bar per day (IST). One series, so one colour and no
 * legend. The readout above names the hovered day (the latest by default), and the same
 * numbers are in a table for screen readers.
 */
function RevenueChart({ days }: { days: AdminOverview['revenueByDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.revenue), 1);
  const shown = days[hover ?? days.length - 1]!;
  const parts = dayParts(shown.day);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <span className="font-display text-3xl font-bold tabular-nums">
          {formatMoney(shown.revenue)}
        </span>
        <span className="text-sm text-dim">
          {parts.top === 'Today' ? 'Today' : `${parts.top} ${parts.day} ${parts.month}`} ·{' '}
          {plural(shown.bookings, 'booking')}
        </span>
      </div>
      <div
        className="grid h-40 grid-cols-7 items-end gap-[2px] border-b border-line"
        aria-hidden="true"
        onMouseLeave={() => setHover(null)}
      >
        {days.map((d, i) => (
          <div
            key={d.day}
            className="flex h-full items-end px-1.5"
            onMouseEnter={() => setHover(i)}
          >
            <div
              className={`w-full rounded-t-[4px] transition-colors ${
                d === shown ? 'bg-marigold' : 'bg-marigold/45'
              }`}
              style={{ height: d.revenue ? `${Math.max(3, (d.revenue / max) * 100)}%` : '2px' }}
            />
          </div>
        ))}
      </div>
      <div
        className="mt-2 grid grid-cols-7 text-center font-mono text-[11px] text-faint"
        aria-hidden="true"
      >
        {days.map((d) => (
          <span key={d.day}>{dayParts(d.day).top}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Confirmed revenue per day, last 7 days</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{formatMoney(d.revenue)}</td>
              <td>{plural(d.bookings, 'booking')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Overview() {
  useTitle('Admin');
  const { data, error, loading } = useLoad(() => api.admin.overview(), []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading || !data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
        <Skeleton className="h-72 sm:col-span-2 lg:col-span-4" />
      </div>
    );
  }

  const t = data.totals;
  const failed = data.outbox.FAILED ?? 0;
  return (
    <>
      <PageHeader title="Overview">
        Revenue counts confirmed bookings only. Days are counted in India Standard Time.
      </PageHeader>

      {failed > 0 && (
        <Notice tone="error" className="mb-6">
          {plural(failed, 'background event')} failed after every retry.{' '}
          <Link to="/admin/events" className="font-semibold underline underline-offset-2">
            Review and retry
          </Link>
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Revenue"
          value={formatMoney(t.revenue)}
          sub={plural(t.confirmedBookings, 'confirmed booking')}
        />
        <StatTile
          label="Tickets sold"
          value={t.ticketsSold}
          sub={plural(t.customers, 'customer account')}
        />
        <StatTile
          label="Upcoming occupancy"
          value={percent(t.upcomingOccupancy)}
          sub={`${t.upcomingBooked} of ${t.upcomingSeats.toLocaleString('en-IN')} seats · ${plural(t.upcomingShows, 'show')}`}
        />
        <StatTile
          label="Right now"
          value={t.activeHolds}
          sub={
            <>
              {t.activeHolds === 1 ? 'live hold' : 'live holds'}
              {t.refundsPending > 0 && ` · ${plural(t.refundsPending, 'refund')} pending`}
            </>
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Revenue, last 7 days" className="lg:col-span-2">
          <RevenueChart days={data.revenueByDay} />
        </Panel>
        <Panel title="By payment gateway">
          {data.revenueByProvider.length === 0 ? (
            <p className="text-sm text-faint">No confirmed bookings yet.</p>
          ) : (
            <ul className="space-y-3">
              {data.revenueByProvider.map((p) => (
                <li key={p.provider} className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">
                    {p.provider === 'CASHFREE' ? 'Cashfree (sandbox)' : 'Simulated gateway'}
                    <span className="block text-xs text-faint">
                      {plural(p.bookings, 'booking')}
                    </span>
                  </span>
                  <span className="font-mono text-sm tabular-nums">{formatMoney(p.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 border-t border-line pt-4">
            <div className="mb-2 font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
              Bookings by state
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {(['CONFIRMED', 'PENDING', 'CANCELLED', 'EXPIRED', 'FAILED'] as const).map((s) => (
                <div key={s} className="flex justify-between">
                  <dt className="text-dim">{s.charAt(0) + s.slice(1).toLowerCase()}</dt>
                  <dd className="font-mono tabular-nums">{data.bookingsByStatus[s] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Top movies">
          {data.topMovies.length === 0 ? (
            <p className="text-sm text-faint">Nothing sold yet.</p>
          ) : (
            <ol className="space-y-2.5">
              {data.topMovies.map((m, i) => (
                <li key={m.id} className="flex items-baseline gap-3 text-sm">
                  <span className="w-4 font-mono text-faint">{i + 1}</span>
                  <Link
                    to={`/movies/${m.slug}`}
                    className="min-w-0 flex-1 truncate hover:text-marigold-hi"
                  >
                    {m.title}
                  </Link>
                  <span className="font-mono text-xs text-dim tabular-nums">
                    {plural(m.tickets, 'ticket')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel
          title="Latest bookings"
          className="lg:col-span-2"
          action={
            <Link
              to="/admin/bookings"
              className="text-xs font-semibold text-marigold-hi hover:underline"
            >
              All bookings
            </Link>
          }
        >
          {data.recentBookings.length === 0 ? (
            <p className="text-sm text-faint">No bookings yet.</p>
          ) : (
            <ul className="divide-y divide-line/60">
              {data.recentBookings.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm first:pt-0"
                >
                  <span className="font-mono text-xs text-faint">{bookingRef(b.id)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {b.movieTitle}
                    <span className="text-faint"> · {b.user.email}</span>
                  </span>
                  <span className="text-xs text-dim">{formatWhen(b.createdAt)}</span>
                  <span className="font-mono tabular-nums">{formatMoney(b.totalAmount)}</span>
                  <StatusPill pill={bookingPill(b.status, b.payment?.status)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
