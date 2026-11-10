import { useState } from 'react';
import { Chip, Notice, Skeleton } from '../../components/ui';
import { api, type OutboxEvent, type OutboxStatus } from '../../lib/api';
import { formatWhen } from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { PageHeader, Panel } from './kit';

const TABS: { status: OutboxStatus; label: string }[] = [
  { status: 'FAILED', label: 'Failed' },
  { status: 'PENDING', label: 'Waiting' },
  { status: 'PROCESSING', label: 'In progress' },
  { status: 'PUBLISHED', label: 'Done' },
];

/** What each event makes the worker do, in plain words. */
const DOES: Record<string, string> = {
  BookingConfirmed: 'Records the customer’s booking confirmation',
  RefundRequired: 'Asks the payment gateway for a refund',
};

function EventRow({ event, onRetried }: { event: OutboxEvent; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.admin.retryOutbox(event.id);
      onRetried();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-mono text-xs text-faint">#{event.id}</span>
        <span className="font-semibold">{event.eventType}</span>
        <span className="text-xs text-dim">{DOES[event.eventType] ?? event.aggregateType}</span>
        <span className="ml-auto text-xs text-faint">{formatWhen(event.createdAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
        <span>
          {event.retryCount} attempt{event.retryCount === 1 ? '' : 's'}
        </span>
        {event.status === 'PENDING' && event.retryCount > 0 && (
          <span>next try {formatWhen(event.nextAttemptAt)}</span>
        )}
        {event.publishedAt && <span>done {formatWhen(event.publishedAt)}</span>}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="font-semibold hover:text-screen"
        >
          {open ? 'Hide details' : 'Details'}
        </button>
        {event.status === 'FAILED' && (
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            className="rounded-full border border-marigold/50 px-3 py-0.5 font-semibold text-marigold-hi hover:bg-marigold hover:text-night disabled:opacity-50"
          >
            {busy ? 'Queuing…' : 'Retry'}
          </button>
        )}
      </div>
      {event.lastError && (
        <p className="mt-1.5 rounded-lg bg-bad/10 px-3 py-1.5 font-mono text-xs text-bad">
          {event.lastError}
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
      {open && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-night px-3 py-2 font-mono text-xs text-dim">
          {JSON.stringify(
            { aggregate: `${event.aggregateType} ${event.aggregateId}`, payload: event.payload },
            null,
            2,
          )}
        </pre>
      )}
    </li>
  );
}

export function Events() {
  useTitle('Background events · Admin');
  const [status, setStatus] = useState<OutboxStatus>('FAILED');
  const [version, setVersion] = useState(0);
  const [retried, setRetried] = useState<string | null>(null);
  const { data, error, loading } = useLoad(() => api.admin.outbox(status), [status, version]);

  return (
    <>
      <PageHeader title="Background events">
        Work that happens after a booking changes (notifications, refunds) is written to an outbox
        in the same transaction, then carried out by the worker with retries. An event that still
        fails after every retry stops here for a person to look at; once the cause is fixed, Retry
        sends it back to the worker.
      </PageHeader>
      <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Chip
            key={t.status}
            active={status === t.status}
            onClick={() => {
              setStatus(t.status);
              setRetried(null);
            }}
          >
            {t.label}
          </Chip>
        ))}
      </div>
      {retried && (
        <Notice tone="success" className="mb-4">
          Event #{retried} is queued again; the worker picks it up within seconds.
        </Notice>
      )}
      <Panel>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <Skeleton className="h-40" />}
        {data && data.events.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">
            {status === 'FAILED' ? 'No failed events. Everything got through.' : 'None.'}
          </p>
        )}
        {data && data.events.length > 0 && (
          <ul className="divide-y divide-line/60">
            {data.events.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                onRetried={() => {
                  setRetried(e.id);
                  setVersion((v) => v + 1);
                }}
              />
            ))}
          </ul>
        )}
        {data && data.events.length === 50 && (
          <p className="mt-4 text-xs text-faint">Showing the latest 50.</p>
        )}
      </Panel>
    </>
  );
}
