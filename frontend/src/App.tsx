import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { Layout } from './components/Layout';
import { AuthProvider, useAuth } from './lib/auth';
import { Checkout } from './pages/Checkout';
import { MyBookings } from './pages/MyBookings';
import { ShowSeats } from './pages/ShowSeats';
import { Shows } from './pages/Shows';
import { SignIn } from './pages/SignIn';

/** Sends signed-out visitors to sign in, then back to where they were going. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!user)
    return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  return children;
}

const router = createBrowserRouter([
  { path: '/signin', element: <SignIn /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <Shows /> },
      { path: '/shows/:showId', element: <ShowSeats /> },
      { path: '/checkout/:bookingId', element: <Checkout /> },
      { path: '/bookings', element: <MyBookings /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
