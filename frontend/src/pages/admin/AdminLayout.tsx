import { useEffect } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { Logo } from '../../components/Layout';
import { WakeBanner } from '../../components/WakeBanner';
import { useAuth } from '../../lib/auth';
import { EmptyState, ButtonLink } from '../../components/ui';

const NAV = [
  ['/admin', 'Overview'],
  ['/admin/bookings', 'Bookings'],
  ['/admin/movies', 'Movies'],
  ['/admin/theatres', 'Theatres & screens'],
  ['/admin/showtimes', 'Showtimes'],
  ['/admin/events', 'Background events'],
] as const;

const link = ({ isActive }: { isActive: boolean }) =>
  `block shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
    isActive ? 'bg-marigold/15 text-marigold-hi' : 'text-dim hover:bg-night-3 hover:text-screen'
  }`;

/**
 * The admin section. The server enforces the ADMIN role on every admin endpoint; this guard
 * only keeps customers from seeing an empty shell.
 */
export function AdminLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  if (loading) return null;
  if (!user) {
    return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  if (user.role !== 'ADMIN') {
    return (
      <div className="mx-auto max-w-xl px-4 py-24">
        <EmptyState title="Admins only" action={<ButtonLink to="/">Back to SeatLock</ButtonLink>}>
          You’re signed in as {user.email}, which isn’t an admin account.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <WakeBanner />
      <header className="sticky top-0 z-40 border-b border-white/5 bg-night/85 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
          <Logo />
          <span className="rounded-full border border-marigold/40 px-2.5 py-0.5 font-mono text-[11px] tracking-[0.18em] text-marigold-hi uppercase">
            Admin
          </span>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="hidden text-faint sm:inline">{user.email}</span>
            <Link to="/" className="font-semibold text-dim hover:text-screen">
              View site ↗
            </Link>
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Admin"
          className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:w-60 lg:shrink-0 lg:flex-col lg:border-r lg:border-b-0 lg:px-3 lg:py-6"
        >
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/admin'} className={link}>
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
