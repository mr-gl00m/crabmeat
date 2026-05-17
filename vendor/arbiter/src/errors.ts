export interface AppErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: string, message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, { statusCode: 400, details });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super("NOT_FOUND", message, { statusCode: 404 });
    this.name = "NotFoundError";
  }
}

export class NotImplementedError extends AppError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message, { statusCode: 501 });
    this.name = "NotImplementedError";
  }
}

export class IntentExpiredError extends AppError {
  constructor(message: string, details?: unknown) {
    super("INTENT_EXPIRED", message, { statusCode: 410, details });
    this.name = "IntentExpiredError";
  }
}

export class SignatureError extends AppError {
  constructor(message: string) {
    super("SIGNATURE_INVALID", message, { statusCode: 401 });
    this.name = "SignatureError";
  }
}

export function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: "INTERNAL_ERROR", message: err.message };
  return { code: "INTERNAL_ERROR", message: String(err) };
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AppError && err.retryable;
}
