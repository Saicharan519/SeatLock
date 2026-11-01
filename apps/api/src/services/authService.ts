import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config/env';
import * as users from '../repositories/userRepository';
import { AppError } from '../utils/errors';
import { signToken } from '../utils/jwt';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: users.Role;
}

const toPublicUser = (u: users.UserRow): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
});

export function createAuthService(pool: Pool, config: ApiConfig) {
  // Compared against when the email is unknown, so login takes the same time either way
  const dummyHash = bcrypt.hashSync('timing-equaliser', config.BCRYPT_ROUNDS);

  const issue = (user: users.UserRow) => ({
    user: toPublicUser(user),
    token: signToken({ id: user.id, role: user.role }, config.JWT_SECRET),
  });

  return {
    async register(input: { name: string; email: string; password: string }) {
      const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_ROUNDS);
      try {
        return issue(await users.insertUser(pool, { ...input, passwordHash }));
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'users_email_unique') {
          throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw err;
      }
    },

    async login(input: { email: string; password: string }) {
      const user = await users.findUserByEmail(pool, input.email);
      const ok = await bcrypt.compare(input.password, user?.password_hash ?? dummyHash);
      if (!user || !ok) throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
      return issue(user);
    },

    async me(userId: string): Promise<PublicUser> {
      const user = await users.findUserById(pool, userId);
      if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
      return toPublicUser(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
