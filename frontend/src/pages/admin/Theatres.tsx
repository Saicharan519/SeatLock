import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, ButtonLink, Notice, Skeleton } from '../../components/ui';
import { api, type AdminTheatre } from '../../lib/api';
import { categoryName } from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { Field, Input, PageHeader, Panel } from './kit';

function AddTheatre({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', city: '', address: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return <Button onClick={() => setOpen(true)}>Add theatre</Button>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.createTheatre(form);
      setForm({ name: '', city: '', address: '' });
      setOpen(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Panel title="New theatre" className="mb-6 w-full">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Name">
          <Input required maxLength={200} value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="City">
          <Input required maxLength={100} value={form.city} onChange={set('city')} />
        </Field>
        <Field label="Address">
          <Input maxLength={500} value={form.address} onChange={set('address')} />
        </Field>
        {error && (
          <Notice tone="error" className="sm:col-span-3">
            {error}
          </Notice>
        )}
        <div className="flex gap-3 sm:col-span-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add theatre'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TheatreCard({ theatre }: { theatre: AdminTheatre }) {
  return (
    <Panel
      title={theatre.name}
      action={
        <ButtonLink
          to={`/admin/theatres/${theatre.id}/screens/new`}
          variant="secondary"
          className="!px-3 !py-1 text-xs"
        >
          Add screen
        </ButtonLink>
      }
    >
      <p className="-mt-1 mb-4 text-xs text-faint">{theatre.address || 'No address'}</p>
      {theatre.screens.length === 0 ? (
        <p className="text-sm text-dim">No screens yet. Add one to schedule shows here.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {theatre.screens.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-sm">
              <span className="font-semibold">{s.name}</span>
              <span className="text-dim">
                {s.seatCount} seats · {s.layout.rows.length} rows
              </span>
              <span className="text-xs text-faint">
                {s.categories.map(categoryName).join(', ')}
              </span>
              <Link
                to={`/admin/showtimes?theatre=${theatre.id}`}
                className="ml-auto text-xs text-dim hover:text-marigold-hi"
              >
                {s.upcomingShows} upcoming show{s.upcomingShows === 1 ? '' : 's'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Theatres() {
  useTitle('Theatres · Admin');
  const added = (useLocation().state as { added?: string } | null)?.added;
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useLoad(() => api.admin.theatres(), [version]);

  const byCity = new Map<string, AdminTheatre[]>();
  for (const t of data?.theatres ?? []) byCity.set(t.city, [...(byCity.get(t.city) ?? []), t]);

  return (
    <>
      <PageHeader title="Theatres & screens">
        A screen’s seat layout is fixed once it exists: every show on it has seats made from that
        layout, and bookings point at those seats.
      </PageHeader>
      {added && (
        <Notice tone="success" className="mb-4">
          Added screen “{added}”.
        </Notice>
      )}
      <div className="mb-6">
        <AddTheatre onAdded={() => setVersion((v) => v + 1)} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !data && <Skeleton className="h-64" />}
      {[...byCity].map(([city, theatres]) => (
        <section key={city} className="mb-8">
          <h2 className="mb-3 font-mono text-xs tracking-[0.2em] text-faint uppercase">
            {city} · {theatres.length}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {theatres.map((t) => (
              <TheatreCard key={t.id} theatre={t} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
