import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { AuthProvider, useAuth } from './lib/auth';
import { CityProvider } from './lib/city';
import { BookingPage } from './pages/BookingPage';
import { Home } from './pages/Home';
import { MoviePage } from './pages/MoviePage';
import { Movies } from './pages/Movies';
import { MyBookings } from './pages/MyBookings';
import { NotFound } from './pages/NotFound';
import { Profile } from './pages/Profile';
import { SeatPage } from './pages/SeatPage';
import { SignIn } from './pages/SignIn';

/**
 * Browsing is open to everyone, as on any ticketing site. Pages that act on your own
 * bookings send signed-out visitors to sign in, then back to where they were going.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}

const auth = (el: ReactNode) => <RequireAuth>{el}</RequireAuth>;

const router = createBrowserRouter([
  { path: '/signin', element: <SignIn /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/movies', element: <Movies /> },
      { path: '/movies/:slug', element: <MoviePage /> },
      { path: '/shows/:showId', element: <SeatPage /> },
      { path: '/checkout/:bookingId', element: auth(<BookingPage />) },
      { path: '/bookings/:bookingId', element: auth(<BookingPage />) },
      { path: '/bookings', element: auth(<MyBookings />) },
      { path: '/profile', element: auth(<Profile />) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <AuthProvider>
      <CityProvider>
        <RouterProvider router={router} />
      </CityProvider>
    </AuthProvider>
  );
}
