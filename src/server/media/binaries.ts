import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config";
import { AppError } from "../errors";
import { runProcess } from "./process";

/**
 * Resolve FFmpeg / FFprobe. Order: explicit env override → pinned npm static binaries.
 * Paths are resolved from the project directory at runtime (not bundled).
 */
function firstExisting(candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

export function ffmpegPath(): string {
  const cfg = getConfig();
  const p = firstExisting([cfg.binaries.ffmpeg, path.join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")]);
  if (!p) throw new AppError("INTERNAL", "FFmpeg binary not found. Run `npm install` or set FFMPEG_PATH.");
  return p;
}

export function ffprobePath(): string {
  const cfg = getConfig();
  const p = firstExisting([
    cfg.binaries.ffprobe,
    path.join(process.cwd(), "node_modules", "ffprobe-static", "bin", process.platform, process.arch, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
  ]);
  if (!p) throw new AppError("INTERNAL", "FFprobe binary not found. Run `npm install` or set FFPROBE_PATH.");
  return p;
}

/** Filters the render + QC pipeline depends on. */
export const REQUIRED_FILTERS = [
  "ass",
  "xfade",
  "zoompan",
  "scale",
  "crop",
  "eq",
  "colorbalance",
  "gblur",
  "overlay",
  "blackdetect",
  "freezedetect",
  "silencedetect",
  "volumedetect",
  "signalstats",
  "blurdetect",
  "afade",
  "alimiter",
  "loudnorm",
  "amix",
  "tile",
] as const;

export interface MediaCapabilities {
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  filters: string[];
  missingFilters: string[];
  hasLibx264: boolean;
  ok: boolean;
}

let capsCache: MediaCapabilities | undefined;

export async function getMediaCapabilities(): Promise<MediaCapabilities> {
  if (capsCache) return capsCache;
  const ff = ffmpegPath();
  const fp = ffprobePath();
  const [ver, pver, filt, enc] = await Promise.all([
    runProcess(ff, ["-hide_banner", "-version"], { timeoutMs: 15_000 }),
    runProcess(fp, ["-hide_banner", "-version"], { timeoutMs: 15_000 }),
    runProcess(ff, ["-hide_banner", "-filters"], { timeoutMs: 15_000 }),
    runProcess(ff, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 }),
  ]);
  const filters = filt.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^[TSC.]{3}$/.test(parts[0] ?? ""))
    .map((parts) => parts[1] as string);
  const missing = REQUIRED_FILTERS.filter((f) => !filters.includes(f));
  const hasLibx264 = /libx264/.test(enc.stdout);
  capsCache = {
    ffmpegPath: ff,
    ffprobePath: fp,
    ffmpegVersion: ver.stdout.split("\n")[0] ?? "unknown",
    ffprobeVersion: pver.stdout.split("\n")[0] ?? "unknown",
    filters,
    missingFilters: missing,
    hasLibx264,
    ok: missing.length === 0 && hasLibx264,
  };
  return capsCache;
}
