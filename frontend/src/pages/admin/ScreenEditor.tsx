import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SeatMap } from '../../components/SeatMap';
import { Button, Notice } from '../../components/ui';
import { api, type LayoutRow } from '../../lib/api';
import { useLoad, useTitle } from '../../lib/hooks';
import { Field, Input, PageHeader, Panel } from './kit';

/** A row as edited: the label comes from its position (first row = A, nearest the screen). */
interface DraftRow {
  category: string;
  seats: string;
  aisles: string;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_SEATS = 600;

/** A typical small auditorium to start from: 6 classic rows, 2 recliner rows at the back. */
const STARTER: DraftRow[] = [
  ...Array.from({ length: 6 }, () => ({ category: 'CLASSIC', seats: '14', aisles: '3, 11' })),
  ...Array.from({ length: 2 }, () => ({ category: 'RECLINER', seats: '8', aisles: '4' })),
];

const toCategory = (s: string) => s.toUpperCase().replace(/[^A-Z_]+/g, '_');

/** Turns the draft into the API's layout, or says what's wrong with it, row by row. */
function build(rows: DraftRow[]): { layout?: { rows: LayoutRow[] }; problems: string[] } {
  const problems: string[] = [];
  const out: LayoutRow[] = rows.map((r, i) => {
    const label = LETTERS[i]!;
    const seats = Number(r.seats);
    const aisleAfter = r.aisles
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number);
    if (!/^[A-Z][A-Z_]{1,19}$/.test(r.category)) {
      problems.push(`Row ${label}: category must be 2 to 20 letters, e.g. CLASSIC`);
    }
    if (!Number.isInteger(seats) || seats < 1 || seats > 99) {
      problems.push(`Row ${label}: seats must be a whole number from 1 to 99`);
    }
    if (aisleAfter.some((n) => !Number.isInteger(n) || n < 1 || n >= seats)) {
      problems.push(`Row ${label}: an aisle goes after a seat inside the row (1 to ${seats - 1})`);
    }
    return { label, category: r.category, seats, aisleAfter: [...new Set(aisleAfter)] };
  });
  const total = out.reduce((n, r) => n + (Number.isFinite(r.seats) ? r.seats : 0), 0);
  if (total > MAX_SEATS)
    problems.push(`A screen has at most ${MAX_SEATS} seats (this has ${total})`);
  return problems.length ? { problems } : { layout: { rows: out }, problems };
}

export function ScreenEditor() {
  const { theatreId } = useParams();
  const navigate = useNavigate();
  const theatres = useLoad(() => api.admin.theatres(), []);
  const theatre = theatres.data?.theatres.find((t) => t.id === theatreId);
  useTitle('Add screen · Admin');

  const [name, setName] = useState('');
  const [rows, setRows] = useState<DraftRow[]>(STARTER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { layout, problems } = useMemo(() => build(rows), [rows]);
  const seatCount = layout?.rows.reduce((n, r) => n + r.seats, 0) ?? 0;
  const categories = useMemo(
    () => [...new Set(['CLASSIC', 'PRIME', 'RECLINER', ...rows.map((r) => r.category)])],
    [rows],
  );

  const update = (i: number, patch: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!layout || !theatreId) return;
    setBusy(true);
    setError(null);
    try {
      await api.admin.createScreen(theatreId, name.trim(), layout);
      navigate('/admin/theatres', { state: { added: name.trim() } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (theatres.error) return <Notice tone="error">{theatres.error}</Notice>;
  if (theatres.data && !theatre) return <Notice tone="error">Theatre not found.</Notice>;

  return (
    <>
      <PageHeader title="Add screen">
        {theatre ? `${theatre.name}, ${theatre.city}. ` : ''}Row A is nearest the screen. Each row
        has a seat category (prices are set per show, per category) and optional aisles: “3, 11”
        puts a gap after seats 3 and 11.
      </PageHeader>
      <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,420px)_1fr]">
        <Panel>
          <Field label="Screen name" className="mb-5">
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Audi 4"
            />
          </Field>
          <datalist id="categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="mb-2 grid grid-cols-[1.5rem_1fr_4.5rem_6rem_1.5rem] gap-2 font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
            <span>Row</span>
            <span>Category</span>
            <span>Seats</span>
            <span>Aisles</span>
            <span />
          </div>
          <ol className="space-y-1.5">
            {rows.map((r, i) => (
              <li
                key={i}
                className="grid grid-cols-[1.5rem_1fr_4.5rem_6rem_1.5rem] items-center gap-2"
              >
                <span className="font-mono text-sm text-dim">{LETTERS[i]}</span>
                <Input
                  list="categories"
                  aria-label={`Row ${LETTERS[i]} category`}
                  value={r.category}
                  onChange={(e) => update(i, { category: toCategory(e.target.value) })}
                  className="!py-1.5 font-mono text-xs"
                />
                <Input
                  type="number"
                  min={1}
                  max={99}
                  aria-label={`Row ${LETTERS[i]} seats`}
                  value={r.seats}
                  onChange={(e) => update(i, { seats: e.target.value })}
                  className="!py-1.5"
                />
                <Input
                  aria-label={`Row ${LETTERS[i]} aisles after seats`}
                  value={r.aisles}
                  onChange={(e) => update(i, { aisles: e.target.value })}
                  placeholder="none"
                  className="!py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  disabled={rows.length === 1}
                  aria-label={`Remove row ${LETTERS[i]}`}
                  className="text-faint hover:text-bad disabled:opacity-30"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="secondary"
            className="mt-3 !py-1.5 text-xs"
            disabled={rows.length >= LETTERS.length}
            onClick={() => setRows((rs) => [...rs, { ...rs[rs.length - 1]! }])}
          >
            Add row {LETTERS[rows.length] ?? ''}
          </Button>

          {problems.length > 0 && (
            <Notice tone="error" className="mt-5">
              <ul className="list-disc space-y-0.5 pl-4">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
          {error && (
            <Notice tone="error" className="mt-5">
              {error}
            </Notice>
          )}
          <div className="mt-6 flex items-center gap-3">
            <Button type="submit" disabled={busy || !layout || !theatre}>
              {busy ? 'Saving…' : layout ? `Create screen · ${seatCount} seats` : 'Create screen'}
            </Button>
            <Link to="/admin/theatres" className="text-sm font-semibold text-dim hover:text-screen">
              Cancel
            </Link>
          </div>
        </Panel>
        <div className="min-w-0 rounded-2xl border border-line bg-night-2 p-4">
          <div className="mb-2 font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
            What customers will see
          </div>
          {layout ? (
            <SeatMap
              rows={layout.rows}
              priceOf={new Map()}
              seats={new Map()}
              selected={new Set()}
              mine={new Set()}
              onToggle={() => undefined}
            />
          ) : (
            <p className="py-16 text-center text-sm text-faint">Fix the rows to see the preview.</p>
          )}
        </div>
      </form>
    </>
  );
}
