/**
 * Minimal structured logger (JSON lines). Never pass media content or secrets here —
 * log identifiers, sizes, timings, and error messages only.
 */
type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEYS = /key|secret|token|password|authorization|cookie/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.VITEST && level !== "error" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ? (redact(data) as object) : {}) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
