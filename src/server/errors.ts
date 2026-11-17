/**
 * Typed application errors. Every error carries a stable machine code, an HTTP status,
 * and a user-facing message. Technical details go to logs, not to the browser.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "CORRUPT_MEDIA"
  | "LIMIT_EXCEEDED"
  | "AI_NOT_CONFIGURED"
  | "AI_FAILED"
  | "TOOL_TIMEOUT"
  | "TOOL_FAILED"
  | "RENDER_FAILED"
  | "CANCELLED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  CORRUPT_MEDIA: 422,
  LIMIT_EXCEEDED: 429,
  AI_NOT_CONFIGURED: 503,
  AI_FAILED: 502,
  TOOL_TIMEOUT: 504,
  TOOL_FAILED: 500,
  RENDER_FAILED: 500,
  CANCELLED: 499,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** True when retrying the same operation may succeed (network blips, timeouts). */
  readonly transient: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; transient?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = opts.details;
    this.transient = opts.transient ?? false;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
