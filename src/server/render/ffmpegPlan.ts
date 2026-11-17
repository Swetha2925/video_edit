import type { Edl, EdlClip } from "@/lib/schemas";
import { TRANSITIONS } from "@/lib/presets";
import { gradeFilter } from "./grades";

/**
 * EDL → FFmpeg invocations (argument arrays only — never shell strings).
 *
 * Stage 1: each clip becomes a normalised segment (exact frame count, output size,
 *          fps, crop/fit, motion, colour grade) encoded at high quality.
 * Stage 2: an audio-only loudness measurement pass (EBU R128, two-pass loudnorm).
 * Stage 3: segments are joined with cuts/xfade transitions, typography is rendered
 *          with libass, audio is mixed/ducked/normalised/limited, and the final
 *          H.264/AAC MP4 is encoded.
 *
 * No user or model text ever enters a filter graph: on-screen words live in the ASS
 * file, and numeric values are validated by the EDL schema before this runs.
 */

export interface PlanPaths {
  /** Resolve an EDL project-relative path ("originals/x.jpg") to an absolute path. */
  resolve: (rel: string) => string;
  workDir: string;
  segmentPath: (i: number) => string;
  /** Final output temp path (renamed into place only after success). */
  outputPath: string;
  /** ASS file and fonts directory, relative to workDir (FFmpeg runs with cwd = workDir). */
  assRel: string | null;
  fontsRel: string;
}

export interface FfmpegStep {
  label: string;
  args: string[];
  /** Media duration this step processes, for progress calculation. */
  durationSec: number;
  /** Relative weight of the step in overall progress. */
  weight: number;
  kind: "segment" | "loudness" | "final";
}

/**
 * Intermediate segments are temporary. Up to 1080p they use UT Video (lossless, ~2× faster
 * to encode and decode than x264 — measured); above that, near-lossless x264 ultrafast
 * keeps temporary disk use reasonable. Both avoid an extra lossy generation.
 */
export function intermediateCodecArgs(W: number, H: number): string[] {
  return W * H <= 1920 * 1080 * 1.1 ? ["-c:v", "utvideo"] : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "10"];
}

const n3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const SUPERSAMPLE = 2;

/** Ease-in-out progress expression for zoompan over N frames. */
function easeExpr(frames: number): string {
  const denom = Math.max(1, frames - 1);
  return `(0.5-0.5*cos(PI*min(on/${denom},1)))`;
}

function fitChain(c: EdlClip, w: number, h: number, isVideo: boolean): string {
  const fx = n3(c.focus.x);
  const fy = n3(c.focus.y);
  if (c.fit === "cover") {
    return `scale=w=${w}:h=${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}:x='(iw-${w})*${fx}':y='(ih-${h})*${fy}'`;
  }
  // contain_blur: whole image over a soft, darkened, blurred fill of itself (no black bars).
  const bw = Math.max(16, Math.round(w / 8 / 2) * 2);
  const bh = Math.max(16, Math.round(h / 8 / 2) * 2);
  const sigma = isVideo ? 6 : 8;
  return (
    `split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=w=${bw}:h=${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${sigma},eq=brightness=-0.07:saturation=0.85,scale=${w}:${h}:flags=bicubic[bg];` +
    `[fgsrc]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2`
  );
}

function motionChain(c: EdlClip, W: number, H: number, fps: number, frames: number, dPerInput: number): string {
  const m = c.motion;
  const e = easeExpr(frames);
  const z = m.zoomFrom === m.zoomTo ? n3(m.zoomFrom) : `${n3(m.zoomFrom)}+(${n3(m.zoomTo - m.zoomFrom)})*${e}`;
  const x = m.xFrom === m.xTo ? n3(m.xFrom) : `${n3(m.xFrom)}+(${n3(m.xTo - m.xFrom)})*${e}`;
  const y = m.yFrom === m.yTo ? n3(m.yFrom) : `${n3(m.yFrom)}+(${n3(m.yTo - m.yFrom)})*${e}`;
  return `zoompan=z='${z}':x='(iw-iw/zoom)*(${x})':y='(ih-ih/zoom)*(${y})':d=${dPerInput}:s=${W}x${H}:fps=${fps}`;
}

export function segmentStep(edl: Edl, i: number, paths: PlanPaths): FfmpegStep {
  const c = edl.clips[i] as EdlClip;
  const { width: W, height: H, fps } = edl.output;
  const durationSec = c.frames / fps;
  const isVideo = c.kind === "video";
  const hasMotion = c.motion.type !== "none";
  const args = ["-hide_banner", "-v", "error", "-y", "-nostats", "-progress", "pipe:1"];
  if (isVideo) {
    args.push("-ss", n3(c.inSec), "-t", n3(durationSec + 0.5), "-i", paths.resolve(c.source));
  } else {
    args.push("-i", paths.resolve(c.source));
  }
  const filters: string[] = [];
  if (isVideo) filters.push(`fps=${fps}`);
  if (hasMotion) {
    const sw = W * SUPERSAMPLE;
    const sh = H * SUPERSAMPLE;
    filters.push(fitChain(c, sw, sh, isVideo));
    filters.push(motionChain(c, W, H, fps, c.frames, isVideo ? 1 : c.frames));
  } else {
    filters.push(fitChain(c, W, H, isVideo));
    // Fit the still once, then repeat that frame with clean constant-rate timestamps.
    if (!isVideo) filters.push(`loop=loop=${c.frames - 1}:size=1:start=0`, `setpts=N/${fps}/TB`);
  }
  if (isVideo) filters.push(`tpad=stop_mode=clone:stop_duration=${n3(durationSec)}`);
  filters.push(gradeFilter(c.grade.preset, c.grade.intensity, c.grade.exposureFix));
  if (i === 0 && edl.fadeIn.videoSec > 0) filters.push(`fade=t=in:st=0:d=${n3(edl.fadeIn.videoSec)}`);
  filters.push(`trim=end_frame=${c.frames}`, "setpts=PTS-STARTPTS", "setsar=1", "format=yuv420p");
  // The fit chain may contain labelled sub-graphs (contain_blur); wrap with explicit in/out labels.
  const graph = `[0:v]${filters.join(",")}[v]`;
  args.push(
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-an",
    ...intermediateCodecArgs(W, H),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-frames:v",
    String(c.frames),
    paths.segmentPath(i),
  );
  return { label: `Scene ${i + 1}: ${isVideo ? "video" : "image"} segment`, args, durationSec, weight: 1, kind: "segment" };
}

interface AudioGraph {
  inputs: string[][];
  filters: string[];
  outLabel: string | null;
}

/** Build the audio mix graph. `firstIndex` is the input index of the first audio input. */
export function buildAudioGraph(edl: Edl, paths: PlanPaths, firstIndex: number): AudioGraph {
  const { fps, totalFrames } = edl.output;
  const total = totalFrames / fps;
  const inputs: string[][] = [];
  const filters: string[] = [];
  let idx = firstIndex;
  let musicLabel: string | null = null;
  const clipLabels: string[] = [];
  const norm = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

  if (edl.music) {
    const m = edl.music;
    inputs.push(["-ss", n3(m.startSec), "-t", n3(total + 1), "-i", paths.resolve(m.source)]);
    const fadeOutStart = Math.max(0, total - m.fadeOutSec);
    filters.push(
      `[${idx}:a]${norm},volume=${n3(m.volume)},afade=t=in:st=0:d=${n3(m.fadeInSec)},apad,atrim=end=${n3(total)},afade=t=out:st=${n3(fadeOutStart)}:d=${n3(m.fadeOutSec)}[mus]`,
    );
    musicLabel = "mus";
    idx++;
  }
  edl.clips.forEach((c, ci) => {
    if (!c.audio.use) return;
    const dur = c.frames / fps;
    const delayMs = Math.round((c.timelineStartFrame / fps) * 1000);
    const fadeIn = Math.min(0.25, dur / 4);
    const fadeOut = Math.min(0.35, dur / 4);
    inputs.push(["-ss", n3(c.inSec), "-t", n3(dur), "-i", paths.resolve(c.source)]);
    filters.push(
      `[${idx}:a]${norm},atrim=end=${n3(dur)},afade=t=in:st=0:d=${n3(fadeIn)},afade=t=out:st=${n3(Math.max(0, dur - fadeOut))}:d=${n3(fadeOut)},volume=${n3(c.audio.volume)},adelay=${delayMs}|${delayMs},apad,atrim=end=${n3(total)}[ca${ci}]`,
    );
    clipLabels.push(`ca${ci}`);
    idx++;
  });
  if (!musicLabel && clipLabels.length === 0) return { inputs, filters, outLabel: null };

  let clipMix: string | null = null;
  if (clipLabels.length === 1) clipMix = clipLabels[0] as string;
  else if (clipLabels.length > 1) {
    filters.push(`${clipLabels.map((l) => `[${l}]`).join("")}amix=inputs=${clipLabels.length}:normalize=0:duration=longest[clipmix]`);
    clipMix = "clipmix";
  }
  let mixed: string;
  if (musicLabel && clipMix) {
    if (edl.music?.duckUnderClipAudio) {
      filters.push(`[${clipMix}]asplit=2[sc][cm]`);
      filters.push(`[${musicLabel}][sc]sidechaincompress=threshold=0.04:ratio=6:attack=25:release=350:makeup=1[musd]`);
      filters.push(`[musd][cm]amix=inputs=2:normalize=0:duration=first[mix]`);
    } else {
      filters.push(`[${musicLabel}][${clipMix}]amix=inputs=2:normalize=0:duration=first[mix]`);
    }
    mixed = "mix";
  } else {
    mixed = (musicLabel ?? clipMix) as string;
  }
  return { inputs, filters, outLabel: mixed };
}

/** Audio-only pass measuring integrated loudness for two-pass loudnorm. */
export function loudnessStep(edl: Edl, paths: PlanPaths): FfmpegStep | null {
  const g = buildAudioGraph(edl, paths, 0);
  if (!g.outLabel) return null;
  const { targetLufs, truePeakDb } = edl.loudness;
  const args = ["-hide_banner", "-nostats", "-y"];
  for (const inp of g.inputs) args.push(...inp);
  const graph = [...g.filters, `[${g.outLabel}]loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11:print_format=json[out]`].join(";");
  args.push("-filter_complex", graph, "-map", "[out]", "-f", "null", "-");
  return { label: "Measuring loudness", args, durationSec: edl.output.totalFrames / edl.output.fps, weight: 0.3, kind: "loudness" };
}

export interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function parseLoudnorm(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
    for (const k of keys) {
      const v = Number(j[k]);
      if (!Number.isFinite(v)) return null;
    }
    return j as unknown as LoudnessMeasurement;
  } catch {
    return null;
  }
}

export function finalStep(edl: Edl, paths: PlanPaths, loudness: LoudnessMeasurement | null): FfmpegStep {
  const { width: W, height: H, fps, totalFrames, crf, preset } = edl.output;
  const total = totalFrames / fps;
  const n = edl.clips.length;
  const args = ["-hide_banner", "-v", "error", "-y", "-nostats", "-progress", "pipe:1"];
  for (let i = 0; i < n; i++) args.push("-i", paths.segmentPath(i));
  const filters: string[] = [];
  let acc = "0:v";
  for (let i = 1; i < n; i++) {
    const c = edl.clips[i] as EdlClip;
    const out = `v${i}`;
    if (c.transitionIn.frames === 0) {
      filters.push(`[${acc}][${i}:v]concat=n=2:v=1:a=0[${out}]`);
    } else {
      const name = TRANSITIONS[c.transitionIn.type].xfade ?? "fade";
      filters.push(`[${acc}][${i}:v]xfade=transition=${name}:duration=${n3(c.transitionIn.frames / fps)}:offset=${n3(c.timelineStartFrame / fps)}[${out}]`);
    }
    acc = out;
  }
  const post: string[] = [];
  if (paths.assRel && edl.texts.length > 0) post.push(`ass=${paths.assRel}:fontsdir=${paths.fontsRel}`);
  if (edl.fadeOut.videoSec > 0) post.push(`fade=t=out:st=${n3(total - edl.fadeOut.videoSec)}:d=${n3(edl.fadeOut.videoSec)}`);
  post.push(`trim=end_frame=${totalFrames}`, "setsar=1", "format=yuv420p");
  filters.push(`[${acc}]${post.join(",")}[vout]`);

  const g = buildAudioGraph(edl, paths, n);
  for (const inp of g.inputs) args.push(...inp);
  filters.push(...g.filters);
  const maps = ["-map", "[vout]"];
  if (g.outLabel) {
    const { targetLufs, truePeakDb } = edl.loudness;
    const ln = loudness
      ? `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11:measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}:measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}:offset=${loudness.target_offset}:linear=true`
      : `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11`;
    const endFade = !edl.music && edl.fadeOut.audioSec > 0 ? `,afade=t=out:st=${n3(total - edl.fadeOut.audioSec)}:d=${n3(edl.fadeOut.audioSec)}` : "";
    // Limiter ceiling ≈ −1.5 dBFS as a final guard against clipping.
    filters.push(`[${g.outLabel}]${ln},aresample=48000,alimiter=limit=0.84:attack=5:release=50:level=disabled,atrim=end=${n3(total)}${endFade}[aout]`);
    maps.push("-map", "[aout]");
  }
  args.push("-filter_complex", filters.join(";"), ...maps);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-g",
    String(fps * 2),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
  );
  if (g.outLabel) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-frames:v", String(totalFrames), "-movflags", "+faststart", "-metadata", "comment=Rendered by ReelCraft AI", paths.outputPath);
  void W;
  void H;
  return { label: "Composing final video", args, durationSec: total, weight: 1.5 * n * 0.4 + 2, kind: "final" };
}
