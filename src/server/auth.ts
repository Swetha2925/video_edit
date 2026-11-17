import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cookies } from "next/headers";
import { db, newId } from "./db";
import { getConfig, ensureDir } from "./config";
import { AppError } from "./errors";

/**
 * Local-first identity. Each browser receives a signed, HTTP-only cookie identifying a
 * local user record. All project operations are scoped to that user, so ownership checks
 * are real and enforced everywhere. A hosted deployment can replace `getSessionUserId`
 * with a proper auth provider without touching the rest of the app.
 */
export const SESSION_COOKIE = "rc_session";

let secretCache: string | undefined;
export function getSessionSecret(): string {
  if (secretCache) return secretCache;
  const cfg = getConfig();
  if (cfg.sessionSecret && cfg.sessionSecret.length >= 16) {
    secretCache = cfg.sessionSecret;
    return secretCache;
  }
  if (cfg.isProd) throw new AppError("INTERNAL", "SESSION_SECRET must be set in production.");
  const file = path.join(ensureDir(cfg.storageRoot), ".session-secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  secretCache = fs.readFileSync(file, "utf8").trim();
  return secretCache;
}

export function signUserId(userId: string): string {
  const mac = createHmac("sha256", getSessionSecret()).update(userId).digest("base64url");
  return `${userId}.${mac}`;
}

export function verifySessionValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return undefined;
  const userId = value.slice(0, idx);
  const expected = signUserId(userId);
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return userId;
}

/** Returns the current user's id, creating a local user + cookie on first visit. */
export async function requireUserId(): Promise<string> {
  const jar = await cookies();
  const existing = verifySessionValue(jar.get(SESSION_COOKIE)?.value);
  if (existing) {
    const user = await db.user.findUnique({ where: { id: existing } });
    if (user) return user.id;
  }
  const user = await db.user.create({ data: { id: newId() } });
  jar.set(SESSION_COOKIE, signUserId(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: getConfig().isProd,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return user.id;
}

/** Ownership check used by every project-scoped operation. Returns the project. */
export async function requireOwnedProject(projectId: string, userId: string) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(projectId)) throw new AppError("NOT_FOUND", "Project not found.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  // Same response for "missing" and "not yours" to avoid leaking project existence.
  if (!project || project.ownerId !== userId) throw new AppError("NOT_FOUND", "Project not found.");
  return project;
}
