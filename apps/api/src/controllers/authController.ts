import type { RequestHandler } from 'express';
import { currentUser } from '../middleware/auth';
import type { AuthService } from '../services/authService';
import { loginSchema, registerSchema } from '../validators/auth';

export function createAuthController(auth: AuthService) {
  const register: RequestHandler = async (req, res) => {
    res.status(201).json(await auth.register(registerSchema.parse(req.body)));
  };

  const login: RequestHandler = async (req, res) => {
    res.json(await auth.login(loginSchema.parse(req.body)));
  };

  const me: RequestHandler = async (req, res) => {
    res.json({ user: await auth.me(currentUser(req).id) });
  };

  return { register, login, me };
}
