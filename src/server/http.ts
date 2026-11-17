import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, isAppError } from "./errors";
import { logger } from "./logger";

/** Wrap a route handler so all errors become consistent JSON responses. */
export function route<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (isAppError(e)) {
    if (e.status >= 500) logger.error("request failed", { code: e.code, message: e.message, details: e.details });
    return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Some fields are invalid.", details: e.issues.slice(0, 20) } },
      { status: 422 },
    );
  }
  logger.error("unhandled request error", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on the server." } }, { status: 500 });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

export function json(data: unknown, status = 200): Response {
  return NextResponse.json(data, { status });
}
