export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'cancelled'
  | 'interrupted'
  | 'capability_missing'
  | 'provider_error'
  | 'insufficient_evidence'
  | 'asset_unavailable'
  | 'quota_exceeded'
  | 'forbidden'
  | 'unauthorized'
  | 'insufficient_sample'
  | 'malformed_provider_output'
  | 'internal';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function asAppError(value: unknown): AppError {
  if (value instanceof AppError) return value;
  return new AppError('internal', value instanceof Error ? value.message : String(value), {
    retryable: false,
    cause: value,
  });
}
