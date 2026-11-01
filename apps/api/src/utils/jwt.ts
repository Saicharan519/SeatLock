import jwt from 'jsonwebtoken';
import type { Role } from '../repositories/userRepository';

export interface AuthUser {
  id: string;
  role: Role;
}

const ALGORITHM = 'HS256';

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ role: user.role }, secret, {
    algorithm: ALGORITHM,
    subject: user.id,
    expiresIn: '1h',
  });
}

/** Returns the user, or undefined for any invalid, expired or malformed token. */
export function verifyToken(token: string, secret: string): AuthUser | undefined {
  try {
    const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    if (typeof payload === 'string' || !payload.sub) return undefined;
    if (payload.role !== 'USER' && payload.role !== 'ADMIN') return undefined;
    return { id: payload.sub, role: payload.role };
  } catch {
    return undefined;
  }
}
