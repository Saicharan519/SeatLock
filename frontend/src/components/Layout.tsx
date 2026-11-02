import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../lib/auth';

const link = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-medium transition-colors ${isActive ? 'text-paper' : 'text-paper/60 hover:text-paper'}`;

export function Layout() {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="bg-ink text-paper">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-2 px-5 py-4">
          <NavLink to="/" className="font-display text-xl font-bold tracking-tight">
            Seat<span className="text-marigold">Lock</span>
          </NavLink>
          <nav className="flex gap-6" aria-label="Main">
            <NavLink to="/" end className={link}>
              Shows
            </NavLink>
            <NavLink to="/bookings" className={link}>
              My bookings
            </NavLink>
          </nav>
          {user && (
            <div className="ml-auto flex items-center gap-4 text-sm">
              <span className="text-paper/60">{user.name}</span>
              <button
                onClick={signOut}
                className="text-paper/80 underline-offset-4 hover:text-paper hover:underline"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-10">
        <Outlet />
      </main>
    </div>
  );
}
