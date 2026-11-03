export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
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
  payment: { id: string; status: PaymentStatus } | null;
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

const TOKEN_KEY = 'seatlock.token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Called when the API says the session is no longer valid. Set by the auth provider. */
let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
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
    if (res.status === 401 && token) onUnauthenticated();
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
  pay: (bookingId: string, idempotencyKey: string) =>
    request<{ paymentId: string; status: string }>('POST', `/bookings/${bookingId}/pay`, {
      idempotencyKey,
    }),
  booking: (id: string) => request<{ booking: Booking }>('GET', `/bookings/${id}`),
  myBookings: () => request<{ bookings: Booking[] }>('GET', '/bookings/me'),
  cancel: (id: string) => request<{ status: string }>('POST', `/bookings/${id}/cancel`),
};
