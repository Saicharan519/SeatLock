import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { useCity } from '../lib/city';
import { WakeBanner } from './WakeBanner';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link
      to="/"
      className={`group flex items-center gap-2 ${className}`}
      aria-label="SeatLock home"
    >
      {/* A cinema seat, seen from the side */}
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
        <rect x="6" y="4" width="15" height="17" rx="4" className="fill-marigold" />
        <rect x="4" y="17" width="24" height="7" rx="3" className="fill-marigold-deep" />
        <rect x="7" y="24" width="3" height="5" rx="1" className="fill-marigold-deep" />
        <rect x="22" y="24" width="3" height="5" rx="1" className="fill-marigold-deep" />
      </svg>
      <span className="font-display text-2xl leading-none font-black tracking-wider uppercase">
        Seat<span className="text-marigold">Lock</span>
      </span>
    </Link>
  );
}

function CityPicker() {
  const { city, cities, setCity } = useCity();
  return (
    <label className="relative flex items-center gap-1.5 rounded-full border border-line-2 py-1.5 pr-3 pl-3 text-sm text-dim transition-colors focus-within:border-marigold hover:border-dim">
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-marigold" aria-hidden="true">
        <path d="M10 1.8a6.2 6.2 0 0 0-6.2 6.2c0 4.6 6.2 10.2 6.2 10.2s6.2-5.6 6.2-10.2A6.2 6.2 0 0 0 10 1.8zm0 8.6a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 0 4.8z" />
      </svg>
      <span className="sr-only">City</span>
      <select
        value={city}
        onChange={(e) => setCity(e.target.value)}
        className="cursor-pointer appearance-none bg-transparent pr-4 font-semibold text-screen outline-none"
      >
        {(cities.length ? cities : [{ city, theatres: 0 }]).map((c) => (
          <option key={c.city} value={c.city} className="bg-night-2">
            {c.city}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 fill-dim"
        aria-hidden="true"
      >
        <path d="M5 7.5l5 5 5-5z" />
      </svg>
    </label>
  );
}

function AccountMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!user) {
    return (
      <Link
        to={`/signin?next=${encodeURIComponent(location.pathname)}`}
        className="rounded-full bg-screen px-4 py-1.5 text-sm font-semibold text-night transition-colors hover:bg-white"
      >
        Sign in
      </Link>
    );
  }

  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="grid h-9 w-9 place-items-center rounded-full bg-marigold/15 font-mono text-xs font-semibold text-marigold-hi ring-1 ring-marigold/40 transition hover:ring-marigold"
      >
        {initials}
        <span className="sr-only">Account menu for {user.name}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 animate-fade overflow-hidden rounded-xl border border-line-2 bg-night-2 shadow-2xl shadow-black/60"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-sm font-semibold">{user.name}</div>
            <div className="truncate text-xs text-faint">{user.email}</div>
          </div>
          {[
            ['/bookings', 'My bookings'],
            ['/profile', 'Profile'],
            ...(user.role === 'ADMIN' ? [['/admin', 'Admin dashboard']] : []),
          ].map(([to, label]) => (
            <Link
              key={to}
              role="menuitem"
              to={to!}
              className="block px-4 py-2.5 text-sm text-dim hover:bg-night-3 hover:text-screen"
            >
              {label}
            </Link>
          ))}
          <button
            role="menuitem"
            type="button"
            onClick={() => void signOut().then(() => navigate('/'))}
            className="block w-full border-t border-line px-4 py-2.5 text-left text-sm text-dim hover:bg-night-3 hover:text-screen"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-semibold transition-colors ${isActive ? 'text-screen' : 'text-dim hover:text-screen'}`;

export function Layout() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="grain flex min-h-screen flex-col">
      <WakeBanner />
      <header className="sticky top-0 z-40 border-b border-white/5 bg-night/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:gap-8 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
            <NavLink to="/" end className={navLink}>
              Home
            </NavLink>
            <NavLink to="/movies" className={navLink}>
              Movies
            </NavLink>
            <NavLink to="/bookings" className={navLink}>
              My bookings
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-4">
            <CityPicker />
            <AccountMenu />
          </div>
        </div>
        {/* Phones: the same links, under the bar */}
        <nav
          className="no-scrollbar flex gap-6 overflow-x-auto border-t border-white/5 px-4 py-2 md:hidden"
          aria-label="Main"
        >
          <NavLink to="/" end className={navLink}>
            Home
          </NavLink>
          <NavLink to="/movies" className={navLink}>
            Movies
          </NavLink>
          <NavLink to="/bookings" className={navLink}>
            My bookings
          </NavLink>
        </nav>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="mt-24 border-t border-line">
        <div className="bulbs opacity-60" aria-hidden="true" />
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-faint sm:grid-cols-[1fr_auto] sm:px-6">
          <div className="max-w-xl space-y-2">
            <Logo className="opacity-80" />
            <p>
              A portfolio project. Payments run against a sandbox gateway: no real money moves and
              no card details are ever collected.
            </p>
            <p className="text-xs">
              Film titles, posters and backdrops are used for demonstration and come from{' '}
              <a
                href="https://www.themoviedb.org/"
                className="underline underline-offset-2 hover:text-dim"
                target="_blank"
                rel="noreferrer"
              >
                TMDB
              </a>
              . Theatres are fictional.
            </p>
          </div>
          <div className="flex gap-6 sm:flex-col sm:gap-2 sm:text-right">
            <Link to="/movies" className="hover:text-dim">
              All movies
            </Link>
            <Link to="/bookings" className="hover:text-dim">
              My bookings
            </Link>
            <a
              href="https://github.com/Saicharan519/SeatLock"
              className="hover:text-dim"
              target="_blank"
              rel="noreferrer"
            >
              Source on GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
