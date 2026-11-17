import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "./binaries";
import { runProcess } from "./process";

/** Thumbnail: 480px-wide JPEG. For videos, a frame at ~15% of the duration. */
export async function generateThumbnail(
  src: string,
  out: string,
  opts: { kind: "image" | "video"; durationSec: number | null; signal?: AbortSignal },
): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ["-v", "error", "-y"];
  if (opts.kind === "video" && opts.durationSec && opts.durationSec > 1) {
    args.push("-ss", (opts.durationSec * 0.15).toFixed(2));
  }
  args.push("-i", src, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2:flags=lanczos", "-q:v", "4", out);
  await runProcess(ffmpegPath(), args, { timeoutMs: 60_000, signal: opts.signal });
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error("Thumbnail was not produced.");
}

/** Downscaled JPEG suitable for sending to a vision model (keeps aspect; long edge ≤ maxDim). */
export async function prepareVisionImage(src: string, out: string, opts: { maxDim?: number; atSec?: number; signal?: AbortSignal } = {}): Promise<void> {
  const max = opts.maxDim ?? 1024;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ["-v", "error", "-y"];
  if (opts.atSec !== undefined) args.push("-ss", opts.atSec.toFixed(3));
  args.push(
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    `scale='if(gt(iw,ih),min(${max},iw),-2)':'if(gt(iw,ih),-2,min(${max},ih))':flags=lanczos`,
    "-q:v",
    "3",
    out,
  );
  await runProcess(ffmpegPath(), args, { timeoutMs: 60_000, signal: opts.signal });
}

/** Evenly spaced keyframes for a video, with timestamps kept attached. */
export async function extractKeyframes(
  src: string,
  outDir: string,
  opts: { durationSec: number; count: number; prefix: string; maxDim?: number; signal?: AbortSignal },
): Promise<{ timeSec: number; file: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const n = Math.max(1, Math.min(opts.count, 12));
  const frames: { timeSec: number; file: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(opts.durationSec - 0.05, ((i + 0.5) * opts.durationSec) / n));
    const file = path.join(outDir, `${opts.prefix}_kf${String(i).padStart(2, "0")}.jpg`);
    await prepareVisionImage(src, file, { atSec: t, maxDim: opts.maxDim ?? 768, signal: opts.signal });
    if (fs.existsSync(file)) frames.push({ timeSec: Math.round(t * 100) / 100, file });
  }
  return frames;
}

export const VisualMetricsSchema = z.object({
  /** Mean luma 0–255. */
  brightness: z.number(),
  /** FFmpeg blurdetect score: higher means softer. ~5 sharp, >10 noticeably soft. */
  blur: z.number(),
  samples: z.number().int(),
  dark: z.boolean(),
  veryDark: z.boolean(),
  soft: z.boolean(),
  blurry: z.boolean(),
  notes: z.array(z.string()),
});
export type VisualMetrics = z.infer<typeof VisualMetricsSchema>;

/** Heuristic thresholds, calibrated against synthetic sharp/blurred/dark references. */
export const METRIC_THRESHOLDS = { dark: 55, veryDark: 35, soft: 9, blurry: 12 } as const;

export function summarizeMetrics(yavg: number[], blur: number[]): VisualMetrics {
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const brightness = Math.round(avg(yavg) * 10) / 10;
  const b = Math.round(avg(blur) * 100) / 100;
  const notes: string[] = [];
  const veryDark = brightness < METRIC_THRESHOLDS.veryDark;
  const dark = brightness < METRIC_THRESHOLDS.dark;
  const blurry = b > METRIC_THRESHOLDS.blurry;
  const soft = b > METRIC_THRESHOLDS.soft;
  if (veryDark) notes.push("Very dark exposure; details may be lost.");
  else if (dark) notes.push("Darker than typical; may need brightening.");
  if (blurry) notes.push("Appears blurry; avoid using as a hero shot or large crop.");
  else if (soft) notes.push("Slightly soft; avoid aggressive zoom.");
  return { brightness, blur: b, samples: Math.max(yavg.length, blur.length), dark, veryDark, soft, blurry, notes };
}

/** Deterministic exposure + sharpness metrics using FFmpeg signalstats and blurdetect. */
export async function measureVisualMetrics(
  src: string,
  opts: { kind: "image" | "video"; durationSec: number | null; signal?: AbortSignal },
): Promise<VisualMetrics> {
  const args = ["-v", "error"];
  let vf = "scale=720:-2,signalstats,blurdetect,metadata=print:file=-";
  if (opts.kind === "video") {
    const d = opts.durationSec ?? 10;
    const step = Math.max(1, d / 8);
    vf = `fps=1/${step.toFixed(3)},${vf}`;
  }
  args.push("-i", src, "-vf", vf, "-an", "-f", "null", "-");
  const res = await runProcess(ffmpegPath(), args, { timeoutMs: 120_000, signal: opts.signal });
  const yavg: number[] = [];
  const blur: number[] = [];
  for (const line of res.stdout.split("\n")) {
    const y = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (y) yavg.push(Number(y[1]));
    const b = /lavfi\.blur=([\d.]+)/.exec(line);
    if (b) blur.push(Number(b[1]));
  }
  return summarizeMetrics(yavg, blur);
}

/** Tile several frames into one contact sheet image (for QC reports and UI). */
export async function buildContactSheet(frames: string[], out: string, opts: { cols?: number; tileWidth?: number; signal?: AbortSignal } = {}): Promise<void> {
  if (frames.length === 0) return;
  const cols = Math.min(opts.cols ?? 5, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const w = opts.tileWidth ?? 216;
  const args = ["-v", "error", "-y"];
  for (const f of frames) args.push("-i", f);
  const scaled = frames.map((_, i) => `[${i}:v]scale=${w}:-2,setsar=1[s${i}]`).join(";");
  const inputs = frames.map((_, i) => `[s${i}]`).join("");
  // Pad missing cells with the last frame so xstack layout stays rectangular.
  const layout: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = c === 0 ? "0" : Array.from({ length: c }, () => "w0").join("+");
    const y = r === 0 ? "0" : Array.from({ length: r }, () => "h0").join("+");
    layout.push(`${x}_${y}`);
  }
  const filter =
    frames.length === 1
      ? `${scaled};[s0]copy[out]`
      : `${scaled};${inputs}xstack=inputs=${frames.length}:layout=${layout.join("|")}:fill=black[out]`;
  args.push("-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "4", out);
  void rows;
  await runProcess(ffmpegPath(), args, { timeoutMs: 60_000, signal: opts.signal });
}
