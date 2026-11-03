/** Error codes and HTTP statuses from PRD section 10. */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  INVALID_SIGNATURE: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SEAT_UNAVAILABLE: 409,
  ACTIVE_HOLD_EXISTS: 409,
  BOOKING_NOT_PAYABLE: 409,
  PAYMENT_IN_PROGRESS: 409,
  INVALID_STATE: 409,
  EMAIL_TAKEN: 409,
  ALREADY_EXISTS: 409,
  SHOW_OVERLAP: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PAYMENT_GATEWAY_ERROR: 502,
  RETRY_LATER: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}
