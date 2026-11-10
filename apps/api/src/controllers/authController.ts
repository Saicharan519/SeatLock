import type { RequestHandler } from 'express';
import type { ApiConfig } from '../config/env';
import { currentUser } from '../middleware/auth';
import type { AuthService } from '../services/authService';
import { clearSessionCookie, setSessionCookie } from '../utils/session';
import { loginSchema, registerSchema } from '../validators/auth';

/**
 * Signing in sets the session cookie (what the website uses). The token is also returned in
 * the body for API clients (tests, k6, curl) that send it as a Bearer header; the website
 * ignores it and never stores it.
 */
export function createAuthController(
  auth: AuthService,
  config: Pick<ApiConfig, 'COOKIE_SECURE' | 'NODE_ENV'>,
) {
  const secure = config.COOKIE_SECURE ?? config.NODE_ENV === 'production';

  const register: RequestHandler = async (req, res) => {
    const result = await auth.register(registerSchema.parse(req.body));
    setSessionCookie(res, result.token, secure);
    res.status(201).json(result);
  };

  const login: RequestHandler = async (req, res) => {
    const result = await auth.login(loginSchema.parse(req.body));
    setSessionCookie(res, result.token, secure);
    res.json(result);
  };

  /** Page scripts can't delete an httpOnly cookie, so signing out is a request. */
  const logout: RequestHandler = (_req, res) => {
    clearSessionCookie(res, secure);
    res.status(204).end();
  };

  const me: RequestHandler = async (req, res) => {
    res.json({ user: await auth.me(currentUser(req).id) });
  };

  return { register, login, logout, me };
}
