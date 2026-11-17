import fs from "node:fs";
import path from "node:path";
import { ffmpegPath } from "../media/binaries";
import { probeMedia, type MediaInfo } from "../media/probe";
import { runProcess } from "../media/process";
import { prepareVisionImage, buildContactSheet } from "../media/derive";
import { AppError } from "../errors";

/**
 * Deterministic inspection of a rendered file: container/stream metadata (FFprobe) plus
 * one full decode pass with blackdetect, freezedetect, silencedetect and volumedetect.
 * A full decode also proves the file is playable end-to-end.
 */
export interface RenderInspection {
  exists: boolean;
  sizeBytes: number;
  info: MediaInfo | null;
  probeError: string | null;
  decodeErrors: string[];
  black: [number, number][];
  frozen: [number, number][];
  silence: [number, number][];
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  tailRmsDb: number | null;
  bitrateKbps: number | null;
}

function pairs(starts: number[], ends: number[], total: number): [number, number][] {
  return starts.map((s, i) => [s, ends[i] ?? total] as [number, number]);
}

export function parseDetectors(stderr: string, totalSec: number) {
  const bs: number[] = [];
  const be: number[] = [];
  const fs_: number[] = [];
  const fe: number[] = [];
  const ss: number[] = [];
  const se: number[] = [];
  let meanVolumeDb: number | null = null;
  let maxVolumeDb: number | null = null;
  const decodeErrors: string[] = [];
  for (const line of stderr.split("\n")) {
    let m = /black_start:([\d.]+)\s+black_end:([\d.]+)/.exec(line);
    if (m) {
      bs.push(Number(m[1]));
      be.push(Number(m[2]));
      continue;
    }
    m = /freeze_start[:=]\s*([\d.]+)/.exec(line);
    if (m) {
      fs_.push(Number(m[1]));
      continue;
    }
    m = /freeze_end[:=]\s*([\d.]+)/.exec(line);
    if (m) {
      fe.push(Number(m[1]));
      continue;
    }
    m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) {
      ss.push(Math.max(0, Number(m[1])));
      continue;
    }
    m = /silence_end:\s*([\d.]+)/.exec(line);
    if (m) {
      se.push(Number(m[1]));
      continue;
    }
    m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(line);
    if (m) {
      meanVolumeDb = m[1] === "-inf" ? -120 : Number(m[1]);
      continue;
    }
    m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(line);
    if (m) {
      maxVolumeDb = m[1] === "-inf" ? -120 : Number(m[1]);
      continue;
    }
    if (/error while decoding|corrupt|invalid data|non-existing PPS|missing picture|concealing/i.test(line)) decodeErrors.push(line.trim().slice(0, 200));
  }
  return {
    black: pairs(bs, be, totalSec),
    frozen: pairs(fs_, fe, totalSec),
    silence: pairs(ss, se, totalSec),
    meanVolumeDb,
    maxVolumeDb,
    decodeErrors: decodeErrors.slice(0, 10),
  };
}

export async function inspectRender(absPath: string, opts: { signal?: AbortSignal } = {}): Promise<RenderInspection> {
  const empty: RenderInspection = {
    exists: false,
    sizeBytes: 0,
    info: null,
    probeError: null,
    decodeErrors: [],
    black: [],
    frozen: [],
    silence: [],
    meanVolumeDb: null,
    maxVolumeDb: null,
    tailRmsDb: null,
    bitrateKbps: null,
  };
  if (!fs.existsSync(absPath)) return empty;
  const sizeBytes = fs.statSync(absPath).size;
  if (sizeBytes === 0) return { ...empty, exists: true };
  let info: MediaInfo | null = null;
  let probeError: string | null = null;
  try {
    info = await probeMedia(absPath, { signal: opts.signal });
  } catch (e) {
    probeError = e instanceof Error ? e.message : String(e);
    return { ...empty, exists: true, sizeBytes, probeError };
  }
  const total = info.durationSec ?? 0;
  const args = ["-hide_banner", "-nostats", "-v", "info", "-i", absPath, "-map", "0:v:0", "-vf", "blackdetect=d=0.25:pix_th=0.08,freezedetect=n=0.001:d=1.5", "-f", "null", "-"];
  if (info.audio) args.push("-map", "0:a:0", "-af", "silencedetect=n=-45dB:d=1.0,volumedetect", "-f", "null", "-");
  let stderr = "";
  try {
    const res = await runProcess(ffmpegPath(), args, { timeoutMs: Math.max(120_000, total * 8000), signal: opts.signal, maxStderrBytes: 2 * 1024 * 1024 });
    stderr = res.stderr + "\n" + res.stdout;
  } catch (e) {
    if (e instanceof AppError && e.code === "CANCELLED") throw e;
    return { ...empty, exists: true, sizeBytes, info, decodeErrors: [e instanceof Error ? e.message : String(e)] };
  }
  const parsed = parseDetectors(stderr, total);
  let tailRmsDb: number | null = null;
  if (info.audio && total > 1) {
    try {
      const tail = await runProcess(
        ffmpegPath(),
        ["-hide_banner", "-nostats", "-v", "info", "-sseof", "-0.4", "-i", absPath, "-vn", "-af", "astats=measure_perchannel=none", "-f", "null", "-"],
        { timeoutMs: 60_000, signal: opts.signal },
      );
      const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(tail.stderr);
      if (m) tailRmsDb = m[1] === "-inf" ? -120 : Number(m[1]);
    } catch {
      tailRmsDb = null;
    }
  }
  return {
    exists: true,
    sizeBytes,
    info,
    probeError,
    ...parsed,
    tailRmsDb,
    bitrateKbps: total > 0 ? Math.round((sizeBytes * 8) / total / 1000) : null,
  };
}

/** Extract review frames at given timestamps, plus a contact sheet. Paths are absolute. */
export async function extractReviewFrames(absPath: string, outDir: string, times: number[], opts: { signal?: AbortSignal } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const frames: { timeSec: number; file: string }[] = [];
  for (const [i, t] of times.entries()) {
    const file = path.join(outDir, `review_${String(i).padStart(2, "0")}.jpg`);
    await prepareVisionImage(absPath, file, { atSec: t, maxDim: 640, signal: opts.signal });
    if (fs.existsSync(file)) frames.push({ timeSec: t, file });
  }
  const sheet = path.join(outDir, "contact_sheet.jpg");
  if (frames.length > 0) await buildContactSheet(frames.map((f) => f.file), sheet, { cols: Math.min(6, frames.length), tileWidth: 200, signal: opts.signal });
  return { frames, contactSheet: fs.existsSync(sheet) ? sheet : null };
}
