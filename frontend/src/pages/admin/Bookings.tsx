import { useEffect, useState } from 'react';
import { Chip, Notice, Skeleton, StatusPill, bookingPill } from '../../components/ui';
import { api, type BookingStatus } from '../../lib/api';
import { bookingRef, formatMoney, formatWhen } from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { Input, PageHeader, Panel, Table, td } from './kit';

const STATUSES: (BookingStatus | undefined)[] = [
  undefined,
  'CONFIRMED',
  'PENDING',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
];

export function Bookings() {
  useTitle('Bookings · Admin');
  const [status, setStatus] = useState<BookingStatus | undefined>();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  // Search as you type, but not on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const { data, error, loading } = useLoad(() => api.admin.bookings({ status, q }), [status, q]);

  return (
    <>
      <PageHeader title="Bookings">
        Everyone’s bookings, newest first (the latest 50 that match). Search by customer email or by
        the reference printed on the ticket.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          {STATUSES.map((s) => (
            <Chip key={s ?? 'all'} active={status === s} onClick={() => setStatus(s)}>
              {s ? s.charAt(0) + s.slice(1).toLowerCase() : 'All'}
            </Chip>
          ))}
        </div>
        <Input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Email or ticket reference"
          aria-label="Search bookings"
          className="sm:ml-auto sm:max-w-xs"
        />
      </div>
      <Panel>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <Skeleton className="h-64" />}
        {data && data.bookings.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">No bookings match.</p>
        )}
        {data && data.bookings.length > 0 && (
          <Table head={['Ref', 'Customer', 'Show', 'Seats', 'Amount', 'Payment', 'State']}>
            {data.bookings.map((b) => (
              <tr key={b.id} className={loading ? 'opacity-60' : ''}>
                <td className={`${td} font-mono text-xs text-dim`}>
                  {bookingRef(b.id)}
                  <div className="mt-0.5 font-sans text-faint">{formatWhen(b.createdAt)}</div>
                </td>
                <td className={td}>
                  {b.user.name}
                  <div className="text-xs text-faint">{b.user.email}</div>
                </td>
                <td className={td}>
                  {b.movieTitle}
                  <div className="text-xs text-faint">
                    {b.theatre.name}, {b.theatre.city} · {b.screenName} · {formatWhen(b.startsAt)}
                  </div>
                </td>
                <td className={`${td} font-mono text-xs`}>{b.seats.join(' ')}</td>
                <td className={`${td} font-mono tabular-nums`}>{formatMoney(b.totalAmount)}</td>
                <td className={`${td} text-xs text-dim`}>
                  {b.payment ? (
                    <>
                      {b.payment.provider === 'CASHFREE' ? 'Cashfree' : 'Simulated'}
                      <div className="text-faint">{b.payment.status}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={td}>
                  <StatusPill pill={bookingPill(b.status, b.payment?.status)} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
