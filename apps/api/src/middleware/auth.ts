import type { Request, RequestHandler } from 'express';
import { AppError } from '../utils/errors';
import { verifyToken, type AuthUser } from '../utils/jwt';
import { CSRF_HEADER, sessionToken } from '../utils/session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Two ways to prove who you are:
 * - the session cookie, which the website uses (httpOnly: page scripts can't read it);
 * - `Authorization: Bearer <token>`, for API clients (tests, the k6 load tests, curl).
 *
 * A cookie is sent by the browser automatically, even on a request another site triggers
 * (CSRF). So a write authenticated by the cookie must also carry the X-SeatLock-Client
 * header, which another site can't make a browser send. A Bearer token is never sent
 * automatically, so it needs no such check.
 */
export function requireAuth(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = bearer ? undefined : sessionToken(req);
    const user = verifyToken(bearer ?? cookie ?? '', jwtSecret);
    if (!user) return next(new AppError('UNAUTHENTICATED', 'Missing or invalid token'));
    if (cookie && !SAFE_METHODS.has(req.method) && !req.get(CSRF_HEADER)) {
      return next(new AppError('FORBIDDEN', 'Missing the X-SeatLock-Client header'));
    }
    req.user = user;
    next();
  };
}

/** Must run after requireAuth. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'ADMIN') return next(new AppError('FORBIDDEN', 'Admin access required'));
  next();
};

/** For handlers behind requireAuth, where req.user is guaranteed. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Missing or invalid token');
  return req.user;
}
