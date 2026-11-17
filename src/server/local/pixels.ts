import fs from "node:fs";
import path from "node:path";
import { ffmpegPath } from "../media/binaries";
import { runProcess } from "../media/process";

/**
 * Small RGB rasters decoded with FFmpeg for on-device image analysis.
 * Frames are resampled to a fixed grid (aspect is not preserved), so positions are
 * expressed as fractions 0–1 of the original frame.
 */
export interface Raster {
  w: number;
  h: number;
  data: Uint8Array; // rgb24
}

export async function decodeRaster(src: string, workDir: string, opts: { w?: number; h?: number; atSec?: number; signal?: AbortSignal } = {}): Promise<Raster> {
  const w = opts.w ?? 96;
  const h = opts.h ?? 96;
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, `raster_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.rgb`);
  const args = ["-v", "error", "-y"];
  if (opts.atSec !== undefined) args.push("-ss", opts.atSec.toFixed(3));
  args.push("-i", src, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-f", "rawvideo", out);
  try {
    await runProcess(ffmpegPath(), args, { timeoutMs: 60_000, signal: opts.signal });
    const buf = fs.readFileSync(out);
    if (buf.length < w * h * 3) throw new Error("Could not decode frame for analysis.");
    return { w, h, data: new Uint8Array(buf.buffer, buf.byteOffset, w * h * 3) };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

const NAMED: [string, number, number, number][] = [
  ["black", 15, 15, 15],
  ["charcoal", 55, 55, 60],
  ["grey", 128, 128, 128],
  ["white", 240, 240, 240],
  ["cream", 240, 225, 190],
  ["beige", 205, 180, 140],
  ["brown", 120, 75, 40],
  ["red", 200, 35, 35],
  ["orange", 235, 130, 40],
  ["gold", 215, 170, 60],
  ["yellow", 240, 220, 60],
  ["olive", 120, 120, 40],
  ["green", 50, 160, 70],
  ["deep green", 25, 80, 40],
  ["teal", 30, 140, 140],
  ["sky blue", 120, 180, 230],
  ["blue", 40, 80, 200],
  ["navy", 20, 30, 80],
  ["purple", 120, 60, 170],
  ["pink", 235, 120, 170],
  ["magenta", 210, 40, 160],
];

export function colorName(r: number, g: number, b: number): string {
  let best = "grey";
  let bd = Infinity;
  for (const [n, nr, ng, nb] of NAMED) {
    // Weighted RGB distance (approximates perceptual difference).
    const dr = r - nr;
    const dg = g - ng;
    const db = b - nb;
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/** k-means on pixels → dominant colours with weights (deterministic seeding). */
export function dominantColors(r: Raster, k = 4): { rgb: [number, number, number]; weight: number; name: string }[] {
  const n = r.w * r.h;
  const step = Math.max(1, Math.floor(n / 2500));
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i += step) pts.push([r.data[i * 3] as number, r.data[i * 3 + 1] as number, r.data[i * 3 + 2] as number]);
  // Seed with luminance quantiles for determinism.
  const sorted = [...pts].sort((a, b) => luma(...a) - luma(...b));
  let centers = Array.from({ length: k }, (_, i) => [...(sorted[Math.floor(((i + 0.5) / k) * sorted.length)] as [number, number, number])] as [number, number, number]);
  let assign = new Array<number>(pts.length).fill(0);
  for (let iter = 0; iter < 10; iter++) {
    assign = pts.map((p) => {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, ci) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = ci;
        }
      });
      return bi;
    });
    centers = centers.map((c, ci) => {
      const members = pts.filter((_, pi) => assign[pi] === ci);
      if (!members.length) return c;
      return [0, 1, 2].map((ch) => members.reduce((s, m) => s + (m[ch] as number), 0) / members.length) as [number, number, number];
    });
  }
  const counts = centers.map((_, ci) => assign.filter((a) => a === ci).length);
  return centers
    .map((c, ci) => ({ rgb: c.map(Math.round) as [number, number, number], weight: (counts[ci] as number) / pts.length, name: colorName(c[0], c[1], c[2]) }))
    .filter((c) => c.weight > 0.04)
    .sort((a, b) => b.weight - a.weight);
}

export interface RegionStats {
  meanLuma: number;
  stdLuma: number;
}

/** Luma statistics inside a fractional box (0–1 coordinates). */
export function regionStats(r: Raster, box: { x0: number; y0: number; x1: number; y1: number }): RegionStats {
  const xs = Math.max(0, Math.floor(box.x0 * r.w));
  const xe = Math.min(r.w, Math.ceil(box.x1 * r.w));
  const ys = Math.max(0, Math.floor(box.y0 * r.h));
  const ye = Math.min(r.h, Math.ceil(box.y1 * r.h));
  let s = 0;
  let s2 = 0;
  let c = 0;
  for (let y = ys; y < ye; y++)
    for (let x = xs; x < xe; x++) {
      const i = (y * r.w + x) * 3;
      const l = luma(r.data[i] as number, r.data[i + 1] as number, r.data[i + 2] as number);
      s += l;
      s2 += l * l;
      c++;
    }
  if (!c) return { meanLuma: 0, stdLuma: 0 };
  const m = s / c;
  return { meanLuma: m, stdLuma: Math.sqrt(Math.max(0, s2 / c - m * m)) };
}
