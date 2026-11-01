import pino from 'pino';

/** Secrets, passwords and tokens must never reach the logs. */
const redact = {
  paths: [
    'password',
    '*.password',
    'passwordHash',
    '*.passwordHash',
    'token',
    '*.token',
    'req.headers.authorization',
    'req.headers["x-signature"]',
    'req.headers.cookie',
  ],
  censor: '[REDACTED]',
};

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info') {
  const pretty = process.env.NODE_ENV === 'development';
  return pino({
    name,
    level,
    redact,
    ...(pretty && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  });
}

export type Logger = pino.Logger;
