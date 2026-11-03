import { useNavigate } from 'react-router';
import { Button, ButtonLink, Eyebrow, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/format';
import { useLoad, useTitle } from '../lib/hooks';

export function Profile() {
  useTitle('Profile');
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data } = useLoad(() => api.myBookings(), []);

  const confirmed = data?.bookings.filter((b) => b.status === 'CONFIRMED') ?? [];
  const upcoming = confirmed.filter((b) => new Date(b.show.startsAt).getTime() > Date.now());
  const spent = confirmed.reduce((sum, b) => sum + b.totalAmount, 0);
  const films = new Set(confirmed.map((b) => b.show.movie.id)).size;

  if (!user) return null;
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="mx-auto max-w-4xl px-4 pt-12 sm:px-6">
      <Eyebrow>Your account</Eyebrow>
      <h1 className="font-display mt-1 text-5xl font-black tracking-wide uppercase">Profile</h1>

      <section className="mt-8 flex flex-wrap items-center gap-6 rounded-3xl border border-line bg-night-2/60 p-6 sm:p-8">
        <div className="grid h-20 w-20 place-items-center rounded-full bg-marigold/15 font-display text-3xl font-black text-marigold-hi ring-1 ring-marigold/40">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-semibold">{user.name}</div>
          <div className="text-dim">{user.email}</div>
          {user.role === 'ADMIN' && (
            <span className="mt-2 inline-block rounded-full bg-marigold/15 px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-marigold-hi uppercase">
              Admin
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            signOut();
            navigate('/');
          }}
        >
          Sign out
        </Button>
      </section>

      <section
        className="mt-6 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-4"
        aria-label="Your activity"
      >
        {(
          [
            ['Upcoming shows', String(upcoming.length)],
            ['Tickets booked', String(confirmed.reduce((n, b) => n + b.seats.length, 0))],
            ['Films seen', String(films)],
            ['Spent', formatMoney(spent)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="bg-night-2 p-6">
            <Eyebrow>{label}</Eyebrow>
            {data ? (
              <div className="font-display mt-2 text-4xl font-black tracking-wide">{value}</div>
            ) : (
              <Skeleton className="mt-3 h-9 w-16" />
            )}
          </div>
        ))}
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink to="/bookings" variant="secondary">
          My bookings
        </ButtonLink>
        <ButtonLink to="/movies" variant="ghost">
          Find a film
        </ButtonLink>
      </div>
    </div>
  );
}
