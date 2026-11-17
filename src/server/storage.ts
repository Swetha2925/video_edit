import path from "node:path";
import fs from "node:fs";
import { getConfig, ensureDir } from "./config";
import { AppError } from "./errors";

/**
 * File storage layout (outside any public / executable directory):
 *
 *   <STORAGE_ROOT>/projects/<projectId>/
 *       originals/   uploaded files, never modified
 *       thumbs/      generated thumbnails
 *       frames/      keyframes, contact sheets, review frames
 *       renders/     rendered outputs (one file per render version; never overwritten)
 *       work/        temporary render intermediates (cleaned up after each job)
 *
 * The database stores paths *relative to the project directory*. Every resolution goes
 * through `resolveProjectPath`, which rejects traversal outside the project root.
 */
export const PROJECT_SUBDIRS = ["originals", "thumbs", "frames", "renders", "work"] as const;
export type ProjectSubdir = (typeof PROJECT_SUBDIRS)[number];

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export function assertSafeId(id: string, label = "id"): void {
  if (!ID_RE.test(id)) throw new AppError("BAD_REQUEST", `Invalid ${label}.`);
}

export function projectRoot(projectId: string): string {
  assertSafeId(projectId, "project id");
  return path.join(getConfig().storageRoot, "projects", projectId);
}

export function ensureProjectDirs(projectId: string): string {
  const root = projectRoot(projectId);
  for (const d of PROJECT_SUBDIRS) ensureDir(path.join(root, d));
  return root;
}

/** Resolve a project-relative path, rejecting anything that escapes the project root. */
export function resolveProjectPath(projectId: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 512) {
    throw new AppError("BAD_REQUEST", "Invalid file path.");
  }
  if (relPath.includes("\0") || path.isAbsolute(relPath)) {
    throw new AppError("FORBIDDEN", "Unsafe file path.");
  }
  const root = projectRoot(projectId);
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError("FORBIDDEN", "Unsafe file path.");
  }
  const parts = rel.split(path.sep);
  const top = parts[0] as ProjectSubdir;
  if (parts.length < 2 || !PROJECT_SUBDIRS.includes(top)) throw new AppError("FORBIDDEN", "Unsafe file path.");
  return resolved;
}

/** Project-relative path builder for files the server creates. */
export function projectRel(subdir: ProjectSubdir, fileName: string): string {
  if (fileName.includes("/") || fileName.includes("\\") || fileName.startsWith(".")) {
    throw new AppError("FORBIDDEN", "Unsafe file name.");
  }
  return `${subdir}/${fileName}`;
}

/**
 * Turn a user-supplied filename into a display-safe string. The stored file never uses
 * this name directly (stored names are `<assetId>.<ext>`), but we keep the original for UI.
 */
export function sanitizeDisplayName(name: string): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  return (cleaned || "file").slice(0, 180);
}

export function removeProjectStorage(projectId: string): void {
  const root = projectRoot(projectId);
  const parent = path.join(getConfig().storageRoot, "projects");
  if (!root.startsWith(parent + path.sep)) throw new AppError("FORBIDDEN", "Unsafe deletion path.");
  fs.rmSync(root, { recursive: true, force: true });
}

export function cleanWorkDir(projectId: string, sub: string): void {
  const dir = resolveProjectPath(projectId, `work/${sub}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
