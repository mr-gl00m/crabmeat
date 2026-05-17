export class CrabMeatError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: number = 500,
    details?: unknown,
  ) {
    super(message);
    this.name = "CrabMeatError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AuthError extends CrabMeatError {
  constructor(message: string, details?: unknown) {
    super("AUTH_FAILED", message, 401, details);
    this.name = "AuthError";
  }
}

export class RateLimitError extends CrabMeatError {
  constructor(message: string = "Rate limit exceeded") {
    super("RATE_LIMITED", message, 429);
    this.name = "RateLimitError";
  }
}

export class ValidationError extends CrabMeatError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
    this.name = "ValidationError";
  }
}

export class ProviderError extends CrabMeatError {
  readonly providerId: string;
  readonly retryable: boolean;

  constructor(
    providerId: string,
    message: string,
    retryable: boolean = false,
    statusCode: number = 502,
  ) {
    super("PROVIDER_ERROR", message, statusCode);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.retryable = retryable;
  }
}

export class ToolValidationError extends CrabMeatError {
  constructor(message: string, details?: unknown) {
    super("TOOL_VALIDATION_ERROR", message, 400, details);
    this.name = "ToolValidationError";
  }
}

export class ToolExecutionError extends CrabMeatError {
  readonly toolId: string;

  constructor(toolId: string, message: string, details?: unknown) {
    super("TOOL_EXECUTION_ERROR", message, 500, details);
    this.name = "ToolExecutionError";
    this.toolId = toolId;
  }
}

export class EffectDeniedError extends CrabMeatError {
  constructor(message: string, details?: unknown) {
    super("EFFECT_DENIED", message, 403, details);
    this.name = "EffectDeniedError";
  }
}

export class ToolRateLimitError extends CrabMeatError {
  constructor(message: string = "Tool invocation rate limit exceeded") {
    super("TOOL_RATE_LIMITED", message, 429);
    this.name = "ToolRateLimitError";
  }
}

export function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof CrabMeatError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "INTERNAL_ERROR", message: err.message };
  }
  return { code: "INTERNAL_ERROR", message: String(err) };
}

// Extract a plain message string from an unknown catch value. This is
// the canonical way to stringify errors in logs, tool results, and user-
// facing response bodies. Centralizing it here means future cross-cutting
// changes (secret masking, PII stripping, consistent humanization) are a
// one-file edit instead of touching every call site.
export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  return false;
}
