import type { CookieOptions, Request, Response } from 'express';

/**
 * The browser session: the same signed JWT as before, now in an httpOnly cookie that page
 * scripts can't read (so an injected script can't steal it), instead of localStorage.
 */
export const SESSION_COOKIE = 'seatlock_session';

/** Matches the JWT's own expiry (signToken: 1 hour). */
const SESSION_SECONDS = 60 * 60;

/**
 * Cookie-authenticated writes must carry this header. A cross-site page can make a browser
 * send cookies (a form post, an image), but it can't add a custom header: fetch() from
 * another origin with one needs a CORS preflight, and this API allows no cross-origin
 * requests. SameSite=Lax already withholds the cookie on cross-site POSTs; this is the
 * second, independent layer.
 */
export const CSRF_HEADER = 'x-seatlock-client';

const options = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: 'lax',
  // Only API requests need it; the site's pages and assets never carry it
  path: '/api',
});

export function setSessionCookie(res: Response, token: string, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, { ...options(secure), maxAge: SESSION_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, options(secure));
}

/** The session token from the Cookie header, without a cookie-parsing dependency. */
export function sessionToken(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    }
  }
  return undefined;
}
