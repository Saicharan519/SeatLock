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

/**
 * `destination` is for tests that read what would have been logged (to prove nothing secret
 * is), with the same redaction rules as production.
 */
export function createLogger(
  name: string,
  level = process.env.LOG_LEVEL ?? 'info',
  destination?: pino.DestinationStream,
) {
  if (destination) return pino({ name, level, redact }, destination);
  const pretty = process.env.NODE_ENV === 'development';
  return pino({
    name,
    level,
    redact,
    ...(pretty && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  });
}

export type Logger = pino.Logger;
