export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type PaymentProvider = 'MOCK' | 'CASHFREE';
export type PaymentStatus = 'INITIATED' | 'SUCCESS' | 'FAILED' | 'REFUND_REQUIRED' | 'REFUNDED';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export interface Price {
  category: string;
  /** paise */
  price: number;
}

export interface MovieSummary {
  id: string;
  slug: string;
  title: string;
  genres: string[];
  language: string;
  durationMinutes: number;
  certificate: 'U' | 'UA' | 'A';
  rating: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string;
}

export interface MovieListItem extends MovieSummary {
  nowShowing: boolean;
  nextShowAt: string | null;
  showCount: number;
  minPrice: number | null;
}

export interface MovieDetail extends MovieSummary {
  synopsis: string;
  director: string;
  cast: string[];
}

export interface Theatre {
  id: string;
  name: string;
  city: string;
  address: string;
}

export interface Showtime {
  id: string;
  startsAt: string;
  endsAt: string;
  screen: { id: string; name: string };
  prices: Price[];
  totalSeats: number;
  availableSeats: number;
}

export interface Show extends Showtime {
  movieId: string;
  movie: MovieSummary;
  theatre: Theatre;
}

export interface LayoutRow {
  label: string;
  category: string;
  seats: number;
  aisleAfter: number[];
}

export interface SeatMap {
  layout: { rows: LayoutRow[] };
  prices: Price[];
  seats: { label: string; status: SeatStatus; category: string }[];
}

export interface Booking {
  id: string;
  status: BookingStatus;
  totalAmount: number;
  expiresAt: string;
  createdAt: string;
  seats: string[];
  items: { label: string; category: string; price: number }[];
  show: {
    id: string;
    startsAt: string;
    movie: {
      id: string;
      slug: string;
      title: string;
      posterUrl: string | null;
      certificate: string;
      language: string;
      durationMinutes: number;
    };
    theatre: { name: string; city: string; address: string };
    screen: { name: string };
  };
  payment: { id: string; status: PaymentStatus; provider: PaymentProvider } | null;
}

// ---- Admin ----

export interface AdminBooking {
  id: string;
  status: BookingStatus;
  totalAmount: number;
  createdAt: string;
  expiresAt: string;
  user: { name: string; email: string };
  movieTitle: string;
  theatre: { name: string; city: string };
  screenName: string;
  startsAt: string;
  seats: string[];
  payment: { status: PaymentStatus; provider: PaymentProvider } | null;
}

export interface AdminOverview {
  timezone: string;
  totals: {
    confirmedBookings: number;
    revenue: number;
    ticketsSold: number;
    activeHolds: number;
    refundsPending: number;
    customers: number;
    upcomingShows: number;
    upcomingSeats: number;
    upcomingBooked: number;
    upcomingOccupancy: number;
  };
  revenueByDay: { day: string; bookings: number; revenue: number }[];
  bookingsByStatus: Partial<Record<BookingStatus, number>>;
  revenueByProvider: { provider: PaymentProvider; bookings: number; revenue: number }[];
  outbox: Partial<Record<OutboxStatus, number>>;
  topMovies: { id: string; slug: string; title: string; tickets: number; revenue: number }[];
  recentBookings: AdminBooking[];
}

export interface AdminScreen {
  id: string;
  name: string;
  seatCount: number;
  layout: { rows: LayoutRow[] };
  categories: string[];
  upcomingShows: number;
}

export interface AdminTheatre extends Theatre {
  screens: AdminScreen[];
}

export interface AdminShow {
  id: string;
  startsAt: string;
  endsAt: string;
  screen: { id: string; name: string };
  movie: { id: string; title: string };
  prices: Price[];
  totalSeats: number;
  bookedSeats: number;
  bookings: number;
}

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  status: OutboxStatus;
  retryCount: number;
  lastError: string | null;
  payload: unknown;
  createdAt: string;
  nextAttemptAt: string;
  publishedAt: string | null;
}

/** The editable fields of a movie (the slug is fixed once created). */
export interface MovieInput {
  title: string;
  synopsis: string;
  genres: string[];
  language: string;
  durationMinutes: number;
  certificate: 'U' | 'UA' | 'A';
  rating: number | null;
  director: string;
  cast: string[];
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string;
}

/** An error from the API, keeping its code (SEAT_UNAVAILABLE, ...) for the UI to act on. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The session is an httpOnly cookie the API sets at sign-in: this code never sees the token,
 * so a script injected into the page couldn't steal it. The browser sends the cookie with
 * every /api request (same origin). Every request also carries this header, which the API
 * requires on cookie-authenticated writes: another site can't make a browser add it (CSRF).
 */
const CLIENT_HEADER = { 'X-SeatLock-Client': 'web' };

/** Earlier versions kept the token in localStorage; remove any left behind. */
localStorage.removeItem('seatlock.token');

/** Called when the API says the session is no longer valid. Set by the auth provider. */
let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

/**
 * Free hosting puts the backend to sleep when nobody uses it; the first request then takes
 * up to a minute. Requests slower than SLOW_MS are reported so the UI can say so, and reads
 * (GET) are retried while the backend wakes. Writes are never retried here: holds and
 * payments carry idempotency keys and are retried deliberately by the pages.
 */
const SLOW_MS = 4000;
const WAKE_RETRIES = 6;
let slowRequests = 0;
const slowListeners = new Set<(waking: boolean) => void>();
function setSlow(delta: number) {
  slowRequests += delta;
  slowListeners.forEach((l) => l(slowRequests > 0));
}
export function onWaking(listener: (waking: boolean) => void): () => void {
  slowListeners.add(listener);
  return () => slowListeners.delete(listener);
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    setSlow(1);
  }, SLOW_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce<T>(method, path, opts);
      } catch (err) {
        const e = err as ApiError;
        // 502/503/504 or no connection while the backend starts up: wait and try again
        const waking = e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
        if (method !== 'GET' || !waking || attempt >= WAKE_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  } finally {
    clearTimeout(timer);
    if (slow) setSlow(-1);
  }
}

async function requestOnce<T>(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  Object.assign(headers, CLIENT_HEADER);
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Can’t reach SeatLock. Check your connection and try again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error ?? {};
    // The session expired or was cleared (sign-in's own 401 for a wrong password isn't that)
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthenticated();
    throw new ApiError(
      res.status,
      err.code ?? 'UNKNOWN',
      err.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  return q ? `?${q}` : '';
};

export const api = {
  register: (name: string, email: string, password: string) =>
    request<{ user: User; token: string }>('POST', '/auth/register', {
      body: { name, email, password },
    }),
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('POST', '/auth/login', { body: { email, password } }),
  me: () => request<{ user: User }>('GET', '/auth/me'),
  logout: () => request<void>('POST', '/auth/logout'),

  cities: () => request<{ cities: { city: string; theatres: number }[] }>('GET', '/cities'),
  movies: (f: { city?: string; genre?: string; language?: string; q?: string }) =>
    request<{ movies: MovieListItem[]; facets: { genres: string[]; languages: string[] } }>(
      'GET',
      `/movies${query(f)}`,
    ),
  movie: (slug: string) => request<{ movie: MovieDetail }>('GET', `/movies/${slug}`),
  showtimes: (slug: string, f: { city?: string; date?: string }) =>
    request<{
      movie: MovieSummary;
      date: string | null;
      dates: string[];
      timezone: string;
      theatres: { theatre: Theatre; shows: Showtime[] }[];
    }>('GET', `/movies/${slug}/showtimes${query(f)}`),
  show: (id: string) => request<{ show: Show }>('GET', `/shows/${id}`),
  seatMap: (id: string) => request<SeatMap>('GET', `/shows/${id}/seats`),

  hold: (showId: string, seats: string[], idempotencyKey: string) =>
    request<{ bookingId: string; expiresAt: string; totalAmount: number }>('POST', '/holds', {
      body: { showId, seats },
      idempotencyKey,
    }),
  release: (bookingId: string) =>
    request<{ status: string }>('POST', `/holds/${bookingId}/release`),
  pay: (bookingId: string, idempotencyKey: string, provider: PaymentProvider = 'MOCK') =>
    request<{
      paymentId: string;
      status: string;
      provider: PaymentProvider;
      paymentSessionId?: string;
    }>('POST', `/bookings/${bookingId}/pay`, {
      idempotencyKey,
      body: provider === 'MOCK' ? undefined : { provider },
    }),
  paymentOptions: () => request<{ providers: PaymentProvider[] }>('GET', '/payments/options'),
  paymentSession: (bookingId: string) =>
    request<{ paymentSessionId: string }>('POST', `/bookings/${bookingId}/payment/session`),
  refreshPayment: (bookingId: string) =>
    request<{ result: string }>('POST', `/bookings/${bookingId}/payment/refresh`),
  booking: (id: string) => request<{ booking: Booking }>('GET', `/bookings/${id}`),
  myBookings: () => request<{ bookings: Booking[] }>('GET', '/bookings/me'),
  cancel: (id: string) => request<{ status: string }>('POST', `/bookings/${id}/cancel`),

  admin: {
    overview: () => request<AdminOverview>('GET', '/admin/overview'),
    bookings: (f: { status?: string; q?: string }) =>
      request<{ bookings: AdminBooking[] }>('GET', `/admin/bookings${query(f)}`),
    theatres: () => request<{ theatres: AdminTheatre[] }>('GET', '/admin/theatres'),
    shows: (theatreId: string, date: string) =>
      request<{ shows: AdminShow[] }>('GET', `/admin/shows${query({ theatreId, date })}`),
    createMovie: (movie: MovieInput) =>
      request<{ movie: MovieDetail }>('POST', '/admin/movies', { body: movie }),
    updateMovie: (id: string, fields: Partial<MovieInput>) =>
      request<{ movie: MovieDetail }>('PATCH', `/admin/movies/${id}`, { body: fields }),
    createTheatre: (t: { name: string; city: string; address: string }) =>
      request<{ theatre: Theatre }>('POST', '/admin/theatres', { body: t }),
    createScreen: (theatreId: string, name: string, layout: { rows: LayoutRow[] }) =>
      request<{ screen: AdminScreen }>('POST', `/admin/theatres/${theatreId}/screens`, {
        body: { name, layout },
      }),
    createShow: (s: {
      movieId: string;
      screenId: string;
      startsAt: string;
      prices: Record<string, number>;
    }) => request<{ show: Show }>('POST', '/admin/shows', { body: s }),
    deleteShow: (id: string) => request<void>('DELETE', `/admin/shows/${id}`),
    outbox: (status: OutboxStatus) =>
      request<{ events: OutboxEvent[] }>('GET', `/admin/outbox-events${query({ status })}`),
    retryOutbox: (id: string) =>
      request<{ event: OutboxEvent }>('POST', `/admin/outbox-events/${id}/retry`),
  },
};
