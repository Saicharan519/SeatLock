import type { AuthUser } from '../utils/jwt';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth */
    user?: AuthUser;
  }
}
