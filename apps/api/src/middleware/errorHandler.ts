import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { RetryExhaustedError } from '@seatlock/db';
import { AppError } from '../utils/errors';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'Route not found'));
};

/** Maps every error to the single PRD error shape: { error: { code, message, requestId } }. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError('VALIDATION_ERROR', 'Invalid request', err.issues);
  } else if (err instanceof RetryExhaustedError) {
    req.log.warn({ err: err.cause }, 'transaction retries exhausted');
    appError = new AppError('RETRY_LATER', 'Server is busy, please retry');
  } else if (err?.type === 'entity.parse.failed') {
    appError = new AppError('VALIDATION_ERROR', 'Malformed JSON body');
  } else {
    req.log.error({ err }, 'unhandled error');
    appError = new AppError('INTERNAL_ERROR', 'Something went wrong');
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.id,
      ...(appError.details !== undefined && { details: appError.details }),
    },
  });
};
