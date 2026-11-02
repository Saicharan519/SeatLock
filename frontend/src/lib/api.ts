export type SeatStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';
export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type PaymentStatus = 'INITIATED' | 'SUCCESS' | 'FAILED' | 'REFUND_REQUIRED' | 'REFUNDED';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export interface Show {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  pricePerSeat: number;
}

export interface Booking {
  id: string;
  status: BookingStatus;
  totalAmount: number;
  expiresAt: string;
  createdAt: string;
  seats: string[];
  show: { id: string; title: string; venue: string; startsAt: string };
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

export const api = {
  register: (name: string, email: string, password: string) =>
    request<{ user: User; token: string }>('POST', '/auth/register', {
      body: { name, email, password },
    }),
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('POST', '/auth/login', { body: { email, password } }),
  me: () => request<{ user: User }>('GET', '/auth/me'),

  shows: () => request<{ shows: Show[] }>('GET', '/shows'),
  show: (id: string) => request<{ show: Show }>('GET', `/shows/${id}`),
  seatMap: (id: string) =>
    request<{ seats: { label: string; status: SeatStatus }[] }>('GET', `/shows/${id}/seats`),

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
