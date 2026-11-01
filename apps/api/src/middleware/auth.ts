import type { Request, RequestHandler } from 'express';
import { AppError } from '../utils/errors';
import { verifyToken, type AuthUser } from '../utils/jwt';

export function requireAuth(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const user = token ? verifyToken(token, jwtSecret) : undefined;
    if (!user) return next(new AppError('UNAUTHENTICATED', 'Missing or invalid token'));
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
