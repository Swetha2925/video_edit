import type { CheckResult, Edl, QcIssue } from "@/lib/schemas";
import type { RenderInspection } from "./inspect";

/**
 * Deterministic quality gates. Compares what was rendered with what the EDL intended.
 * Ranges the EDL marks as intentional (fade to black, static stills) are not defects.
 */
export interface TechnicalEvaluation {
  technical: CheckResult[];
  audio: CheckResult[];
  visual: CheckResult[];
  issues: QcIssue[];
  blockingFailures: number;
}

export function durationToleranceSec(expected: number): number {
  return Math.max(0.12, expected * 0.01);
}

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/** Portion of a detected range not covered by intentional ranges. */
export function unexpectedPortion(range: [number, number], intentional: [number, number][], pad = 0.3): number {
  const len = range[1] - range[0];
  const covered = intentional.reduce((s, r) => s + overlap(range, [r[0] - pad, r[1] + pad]), 0);
  return Math.max(0, len - covered);
}

export function sceneAt(edl: Edl, t: number): string | null {
  const fps = edl.output.fps;
  for (const c of edl.clips) {
    const s = c.timelineStartFrame / fps;
    const e = (c.timelineStartFrame + c.frames) / fps;
    if (t >= s && t < e) return c.sceneId;
  }
  return null;
}

export function evaluateTechnical(ins: RenderInspection, edl: Edl): TechnicalEvaluation {
  const technical: CheckResult[] = [];
  const audio: CheckResult[] = [];
  const visual: CheckResult[] = [];
  const issues: QcIssue[] = [];
  const expectedDur = edl.output.totalFrames / edl.output.fps;
  const add = (list: CheckResult[], id: string, label: string, status: CheckResult["status"], detail: string, blocking: boolean) =>
    list.push({ id, label, status, detail, blocking });

  add(technical, "file_exists", "Output file exists and is non-empty", ins.exists && ins.sizeBytes > 0 ? "pass" : "fail", ins.exists ? `${(ins.sizeBytes / 1e6).toFixed(2)} MB` : "No output file found", true);
  add(technical, "container_readable", "Container can be read", ins.info ? "pass" : "fail", ins.info ? ins.info.formatName : ins.probeError ?? "Unreadable", true);
  const v = ins.info?.video ?? null;
  add(technical, "video_stream", "Video stream present (H.264)", v && v.codec === "h264" ? "pass" : "fail", v ? `${v.codec}, ${v.pixFmt ?? "?"}` : "No video stream", true);
  if (v) {
    const resOk = v.width === edl.output.width && v.height === edl.output.height;
    add(technical, "resolution", "Resolution matches requested output", resOk ? "pass" : "fail", `${v.width}×${v.height} (expected ${edl.output.width}×${edl.output.height})`, true);
    const ar = v.width / v.height;
    const er = edl.output.width / edl.output.height;
    add(technical, "aspect_ratio", "Aspect ratio is correct", Math.abs(ar - er) < 0.01 ? "pass" : "fail", `${ar.toFixed(4)} (expected ${er.toFixed(4)})`, true);
    const fpsOk = v.fps !== null && Math.abs(v.fps - edl.output.fps) < 0.05;
    add(technical, "frame_rate", "Frame rate is valid", fpsOk ? "pass" : "fail", `${v.fps ?? "unknown"} fps (expected ${edl.output.fps})`, true);
    add(technical, "pixel_format", "Pixel format is widely playable (yuv420p)", v.pixFmt === "yuv420p" ? "pass" : "fail", v.pixFmt ?? "unknown", true);
  }
  const dur = ins.info?.durationSec ?? null;
  if (dur !== null) {
    const tol = durationToleranceSec(expectedDur);
    const ok = Math.abs(dur - expectedDur) <= tol;
    add(technical, "duration", "Duration within tolerance", ok ? "pass" : "fail", `${dur.toFixed(2)}s (expected ${expectedDur.toFixed(2)}s ±${tol.toFixed(2)}s)`, true);
    if (!ok) issues.push({ source: "technical", severity: "high", description: `Output is ${dur.toFixed(2)}s but ${expectedDur.toFixed(2)}s was planned.`, timeSec: null, sceneId: null, suggestedFix: "Re-render; check clip lengths.", certainty: "confirmed" });
  } else {
    add(technical, "duration", "Duration within tolerance", "fail", "Duration unknown", true);
  }
  add(
    technical,
    "decodable",
    "Full decode without errors (playable, not corrupt)",
    ins.info && ins.decodeErrors.length === 0 ? "pass" : "fail",
    ins.decodeErrors.length ? ins.decodeErrors.slice(0, 3).join(" | ") : ins.info ? "Decoded every frame" : "Not decodable",
    true,
  );
  if (ins.bitrateKbps !== null) {
    const minKbps = (edl.output.width * edl.output.height) / 1000; // ~2 Mbps at 1080×1920
    add(technical, "bitrate", "Bitrate sufficient for the resolution", ins.bitrateKbps >= minKbps * 0.5 ? "pass" : "warn", `${ins.bitrateKbps} kbps`, false);
  }

  // Audio
  const a = ins.info?.audio ?? null;
  if (edl.expectsAudio) {
    add(audio, "audio_stream", "Audio stream present (AAC)", a && a.codec === "aac" ? "pass" : "fail", a ? `${a.codec}, ${a.sampleRate ?? "?"} Hz, ${a.channels ?? "?"} ch` : "Missing audio stream", true);
    if (a) {
      const ad = a.durationSec ?? 0;
      const adOk = Math.abs(ad - expectedDur) <= Math.max(0.25, expectedDur * 0.015);
      add(audio, "audio_duration", "Audio duration matches video", adOk ? "pass" : "warn", `${ad.toFixed(2)}s`, false);
      const maxV = ins.maxVolumeDb;
      const clipping = maxV !== null && maxV > -0.5;
      add(audio, "clipping", "Peak level / no clipping", maxV === null ? "warn" : clipping ? "fail" : "pass", maxV === null ? "Not measured" : `Peak ${maxV.toFixed(1)} dBFS`, true);
      if (clipping) issues.push({ source: "audio", severity: "high", description: `Audio peaks at ${maxV?.toFixed(1)} dBFS (clipping risk).`, timeSec: null, sceneId: null, suggestedFix: "Lower music volume.", certainty: "confirmed" });
      const meanV = ins.meanVolumeDb;
      const tooQuiet = meanV !== null && meanV < -35;
      add(audio, "loudness", "Overall level is audible", meanV === null ? "warn" : tooQuiet ? "fail" : "pass", meanV === null ? "Not measured" : `Mean ${meanV.toFixed(1)} dB`, true);
      const fadeZone: [number, number] = [expectedDur - Math.max(edl.fadeOut.audioSec, 0.5) - 0.3, expectedDur + 1];
      const unexpectedSilence = ins.silence.filter((r) => unexpectedPortion(r, [fadeZone, [0, edl.music?.fadeInSec ?? 0]]) > 0.8);
      add(audio, "silence", "No unexpected silence", unexpectedSilence.length ? "fail" : "pass", unexpectedSilence.length ? unexpectedSilence.map((r) => `${r[0].toFixed(1)}–${r[1].toFixed(1)}s`).join(", ") : "None detected", true);
      for (const r of unexpectedSilence)
        issues.push({ source: "audio", severity: "high", description: `Unexpected silence from ${r[0].toFixed(1)}s to ${r[1].toFixed(1)}s.`, timeSec: r[0], sceneId: sceneAt(edl, r[0]), suggestedFix: "Check music length/start point or clip audio.", certainty: "confirmed" });
      const tail = ins.tailRmsDb;
      const abrupt = tail !== null && meanV !== null && tail > meanV - 3 && tail > -30;
      add(audio, "ending", "Audio ends smoothly (no abrupt cut)", tail === null ? "warn" : abrupt ? "warn" : "pass", tail === null ? "Not measured" : `Last 0.4s RMS ${tail.toFixed(1)} dB`, false);
      if (abrupt) issues.push({ source: "audio", severity: "medium", description: "Audio appears to end abruptly.", timeSec: expectedDur, sceneId: null, suggestedFix: "Lengthen the closing audio fade.", certainty: "likely" });
    }
  } else {
    add(audio, "audio_stream", "No audio stream (silent output requested or no audio sources)", a ? "warn" : "pass", a ? "Unexpected audio stream present" : "Silent as planned", false);
  }

  // Visual (deterministic)
  const unexpectedBlack = ins.black.filter((r) => unexpectedPortion(r, edl.intentional.darkRanges) > 0.25);
  add(visual, "black_frames", "No unexpected black frames", unexpectedBlack.length ? "fail" : "pass", unexpectedBlack.length ? unexpectedBlack.map((r) => `${r[0].toFixed(1)}–${r[1].toFixed(1)}s`).join(", ") : `None (${ins.black.length} intentional fade${ins.black.length === 1 ? "" : "s"})`, true);
  for (const r of unexpectedBlack)
    issues.push({ source: "visual", severity: "high", description: `Unexpected black frames ${r[0].toFixed(1)}–${r[1].toFixed(1)}s.`, timeSec: r[0], sceneId: sceneAt(edl, r[0]), suggestedFix: "Check the source asset or exposure; replace or brighten the scene.", certainty: "confirmed" });
  const unexpectedFrozen = ins.frozen.filter((r) => unexpectedPortion(r, [...edl.intentional.staticRanges, ...edl.intentional.darkRanges]) > 1.0);
  add(visual, "frozen_frames", "No unexpected frozen sections", unexpectedFrozen.length ? "warn" : "pass", unexpectedFrozen.length ? unexpectedFrozen.map((r) => `${r[0].toFixed(1)}–${r[1].toFixed(1)}s`).join(", ") : "None detected", false);
  for (const r of unexpectedFrozen)
    issues.push({ source: "visual", severity: "medium", description: `Picture appears frozen ${r[0].toFixed(1)}–${r[1].toFixed(1)}s.`, timeSec: r[0], sceneId: sceneAt(edl, r[0]), suggestedFix: "Add gentle motion or shorten the scene.", certainty: "likely" });
  const upscaled = edl.clips.filter((c) => c.upscaled);
  add(visual, "upscaling", "Sources meet output resolution", upscaled.length ? "warn" : "pass", upscaled.length ? `${upscaled.length} clip(s) upscaled from lower-resolution sources — no detail is added by upscaling` : "All sources ≥ output resolution", false);
  const textWarn = edl.texts.filter((t) => t.box.left < edl.safeArea.left - 2 || t.box.right > edl.output.width - edl.safeArea.right + 2 || t.box.top < edl.safeArea.top - 2 || t.box.bottom > edl.output.height - edl.safeArea.bottom + 2);
  add(visual, "text_safe_area", "Text inside platform safe area", textWarn.length ? "warn" : "pass", textWarn.length ? `${textWarn.length} text element(s) near UI zones` : `${edl.texts.length} text element(s) checked`, false);

  const blockingFailures = [...technical, ...audio, ...visual].filter((c) => c.blocking && c.status === "fail").length;
  return { technical, audio, visual, issues, blockingFailures };
}

/** Honest quality label derived from measured properties, never assumed. */
export function qualityLabel(width: number | null, height: number | null, upscaledClips: number): string {
  if (!width || !height) return "Unknown";
  const short = Math.min(width, height);
  const base = short >= 2160 ? "4K UHD" : short >= 1080 ? "Full HD 1080p" : short >= 720 ? "HD 720p" : "SD";
  return upscaledClips > 0 ? `${base} output (${upscaledClips} clip${upscaledClips === 1 ? "" : "s"} upscaled from lower-resolution sources)` : `${base} output`;
}

/** Review frame timestamps: opening, each scene midpoint, and the ending. */
export function reviewTimestamps(edl: Edl, max = 10): number[] {
  const fps = edl.output.fps;
  const total = edl.output.totalFrames / fps;
  const times = new Set<number>([Math.min(0.6, total / 4)]);
  for (const c of edl.clips) times.add(Math.round(((c.timelineStartFrame + c.frames / 2) / fps) * 100) / 100);
  const endCard = edl.texts.find((t) => t.id === "end_title");
  times.add(Math.round((endCard ? Math.min(total - 0.5, endCard.startSec + 1.0) : total - 1.0) * 100) / 100);
  let list = [...times].filter((t) => t >= 0 && t < total).sort((a, b) => a - b);
  if (list.length > max) {
    const step = list.length / max;
    list = Array.from({ length: max }, (_, i) => list[Math.floor(i * step)] as number);
  }
  return list;
}
