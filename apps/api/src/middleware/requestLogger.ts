import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { Logger } from '@seatlock/shared';

const VALID_REQUEST_ID = /^[\w-]{1,64}$/;

/** Query parameters that can hold personal data (the admin booking search takes an email). */
const PRIVATE_PARAMS = /([?&](?:q|email)=)[^&]*/gi;

/** The URL as logged: path and query, with private parameter values replaced. */
export const loggableUrl = (url: string) => url.replace(PRIVATE_PARAMS, '$1[REDACTED]');

/**
 * Assigns a request ID (honouring a sane incoming X-Request-Id) and logs each request in one
 * compact line: id, method, URL, status and time. Headers are not logged (they made every
 * line hundreds of characters and buried the events that matter, and they can carry tokens).
 * Successful health checks are not logged at all: the hosting platform calls /api/health
 * every few seconds. A failing health check (5xx) is still logged as an error.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      return req.url === '/api/health' ? 'silent' : 'info';
    },
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: loggableUrl(req.url),
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
