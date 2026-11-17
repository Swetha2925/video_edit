import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "./binaries";
import { runProcess } from "./process";

/**
 * Deterministic music analysis: loudness, tempo and beat grid.
 * Used to snap cuts to the music (beat-synchronised editing) and to set mix levels.
 */
export const AudioAnalysisSchema = z.object({
  durationSec: z.number(),
  peakDb: z.number(),
  rmsDb: z.number(),
  bpm: z.number().nullable(),
  bpmConfidence: z.number(),
  beats: z.array(z.number()),
  /** Normalised loudness envelope, one value per 0.5 s (0–1). */
  energy: z.array(z.number()),
});
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;

const SR = 11025;
const HOP = 256;
const WIN = 1024;

export function toDb(x: number): number {
  return x <= 1e-9 ? -120 : Math.round(20 * Math.log10(x) * 10) / 10;
}

/** Pure analysis over mono float samples (exported for unit tests). */
export function analyseSamples(samples: Float32Array, sampleRate = SR): AudioAnalysis {
  const n = samples.length;
  const durationSec = n / sampleRate;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
    sumSq += v * v;
  }
  const rms = n ? Math.sqrt(sumSq / n) : 0;

  // Frame energies → onset strength (half-wave rectified log-energy difference).
  const frames = Math.max(0, Math.floor((n - WIN) / HOP));
  const logE = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) {
      const s = samples[off + i] as number;
      e += s * s;
    }
    logE[f] = Math.log(1e-10 + e / WIN);
  }
  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, (logE[f] as number) - (logE[f - 1] as number));
  // Remove slow trend (local mean over ~0.5 s).
  const half = Math.round((0.25 * sampleRate) / HOP);
  const detr = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, f - half); k < Math.min(frames, f + half); k++) {
      s += onset[k] as number;
      c++;
    }
    detr[f] = Math.max(0, (onset[f] as number) - (c ? s / c : 0));
  }

  // Energy envelope per 0.5 s.
  const per = Math.max(1, Math.round((0.5 * sampleRate) / HOP));
  const energyRaw: number[] = [];
  for (let f = 0; f < frames; f += per) {
    let s = 0;
    let c = 0;
    for (let k = f; k < Math.min(frames, f + per); k++) {
      s += Math.exp(logE[k] as number);
      c++;
    }
    energyRaw.push(c ? Math.sqrt(s / c) : 0);
  }
  const maxE = Math.max(1e-9, ...energyRaw);
  const energy = energyRaw.map((e) => Math.round((e / maxE) * 1000) / 1000);

  // Tempo via autocorrelation in 70–180 BPM with a mild preference around 110 BPM.
  let bpm: number | null = null;
  let confidence = 0;
  let beats: number[] = [];
  const fps = sampleRate / HOP;
  if (frames > fps * 4) {
    const minLag = Math.floor((60 / 180) * fps);
    const maxLag = Math.ceil((60 / 70) * fps);
    const ac: number[] = [];
    let acSum = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let f = 0; f + lag < frames; f++) s += (detr[f] as number) * (detr[f + lag] as number);
      const tempo = (60 * fps) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(tempo / 110) / 0.9, 2));
      ac.push(s * w);
      acSum += s * w;
    }
    let best = 0;
    for (let i = 1; i < ac.length; i++) if ((ac[i] as number) > (ac[best] as number)) best = i;
    const meanAc = acSum / Math.max(1, ac.length);
    confidence = meanAc > 0 ? Math.min(1, ((ac[best] as number) / meanAc - 1) / 3) : 0;
    // Parabolic refinement of the peak lag.
    let lag = best + minLag;
    const y0 = ac[best - 1];
    const y1 = ac[best] as number;
    const y2 = ac[best + 1];
    if (y0 !== undefined && y2 !== undefined) {
      const denom = y0 - 2 * y1 + y2;
      if (denom !== 0) lag += (0.5 * (y0 - y2)) / denom;
    }
    bpm = Math.round(((60 * fps) / lag) * 10) / 10;
    // Beat phase: offset maximising the summed onset strength on the grid.
    const period = lag;
    let bestOff = 0;
    let bestScore = -1;
    for (let off = 0; off < period; off++) {
      let s = 0;
      for (let t = off; t < frames; t += period) s += detr[Math.round(t)] ?? 0;
      if (s > bestScore) {
        bestScore = s;
        bestOff = off;
      }
    }
    for (let t = bestOff; t < frames && beats.length < 2000; t += period) beats.push(Math.round(((t * HOP) / sampleRate) * 1000) / 1000);
    if (confidence < 0.05) {
      bpm = null;
      beats = [];
    }
  }

  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    peakDb: toDb(peak),
    rmsDb: toDb(rms),
    bpm,
    bpmConfidence: Math.round(confidence * 100) / 100,
    beats,
    energy,
  };
}

/** Decode audio to mono PCM (in the work dir) and analyse it. */
export async function analyseAudioFile(src: string, workDir: string, opts: { signal?: AbortSignal; maxSec?: number } = {}): Promise<AudioAnalysis> {
  fs.mkdirSync(workDir, { recursive: true });
  const raw = path.join(workDir, `pcm_${Date.now()}_${Math.random().toString(36).slice(2)}.f32`);
  try {
    await runProcess(
      ffmpegPath(),
      ["-v", "error", "-y", "-i", src, "-t", String(opts.maxSec ?? 900), "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", raw],
      { timeoutMs: 180_000, signal: opts.signal },
    );
    const buf = fs.readFileSync(raw);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    return AudioAnalysisSchema.parse(analyseSamples(samples));
  } finally {
    fs.rmSync(raw, { force: true });
  }
}
