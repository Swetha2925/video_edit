import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

// Shared via `process` so every Next.js route context reuses one client/connection pool.
const globalForPrisma = process as unknown as { __reelcraftPrisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.__reelcraftPrisma ?? new PrismaClient();
if (!globalForPrisma.__reelcraftPrisma) globalForPrisma.__reelcraftPrisma = db;

export function newId(): string {
  return randomUUID();
}

/** Parse a JSON column; returns undefined for null/invalid. Validate the result with Zod at call sites. */
export function parseJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
