import { StoryboardSchema, type Storyboard } from "@/lib/schemas";
import type { CompileContext, ValidationOutcome } from "./types";

/** Tolerance for the storyboard's total duration vs the requested duration. */
export function durationTolerance(target: number): number {
  return Math.max(0.5, target * 0.03);
}

export function storyboardDuration(sb: Storyboard): number {
  return Math.round(sb.scenes.reduce((s, sc) => s + sc.durationSec, 0) * 1000) / 1000;
}

/**
 * Deterministic repair: scale scene durations so the total matches the target exactly.
 * Used by the harness before validation; recorded as a warning, never silent.
 */
export function normalizeDurations(sb: Storyboard, target: number): { storyboard: Storyboard; changed: boolean } {
  const total = storyboardDuration(sb);
  if (total <= 0 || Math.abs(total - target) < 0.02) return { storyboard: sb, changed: false };
  const k = target / total;
  const scenes = sb.scenes.map((s) => ({ ...s, durationSec: Math.max(0.6, Math.round(s.durationSec * k * 100) / 100) }));
  // Put rounding remainder on the longest scene.
  const diff = Math.round((target - scenes.reduce((s, sc) => s + sc.durationSec, 0)) * 100) / 100;
  if (Math.abs(diff) > 0) {
    let li = 0;
    scenes.forEach((s, i) => {
      if (s.durationSec > (scenes[li] as typeof s).durationSec) li = i;
    });
    const longest = scenes[li] as (typeof scenes)[number];
    longest.durationSec = Math.max(0.6, Math.round((longest.durationSec + diff) * 100) / 100);
  }
  return { storyboard: { ...sb, scenes }, changed: true };
}

/** Strict validation of a storyboard against the project's assets and settings. */
export function validateStoryboard(input: unknown, ctx: CompileContext): ValidationOutcome & { storyboard?: Storyboard } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = StoryboardSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "storyboard"}: ${i.message}`),
      warnings,
    };
  }
  const sb = parsed.data;
  const ids = new Set<string>();
  sb.scenes.forEach((s, idx) => {
    const label = `Scene ${idx + 1} (${s.id})`;
    if (ids.has(s.id)) errors.push(`${label}: duplicate scene id.`);
    ids.add(s.id);
    const a = ctx.assets.get(s.assetId);
    if (!a) {
      errors.push(`${label}: asset "${s.assetId}" does not exist in this project.`);
      return;
    }
    if (a.excluded) errors.push(`${label}: asset "${a.originalName}" was excluded by the user.`);
    if (a.status !== "ready") errors.push(`${label}: asset "${a.originalName}" is not ready (status ${a.status}).`);
    if (a.kind === "audio") errors.push(`${label}: "${a.originalName}" is an audio file and cannot be used as a visual.`);
    if (a.kind === "video") {
      const d = a.durationSec ?? 0;
      if (s.sourceInSec >= d - 0.3) errors.push(`${label}: sourceInSec ${s.sourceInSec}s is beyond the clip length (${d.toFixed(2)}s).`);
      else if (s.sourceInSec + s.durationSec > d + 0.05) warnings.push(`${label}: the clip is shorter than the scene from that in-point; the in-point will be moved earlier.`);
    }
    if (s.useClipAudio && a.kind === "video" && !a.hasAudio) warnings.push(`${label}: clip has no audio track; clip audio will be ignored.`);
    if (idx > 0 && s.transitionIn.type !== "cut") {
      const prev = sb.scenes[idx - 1];
      const maxT = Math.min(s.durationSec, prev ? prev.durationSec : s.durationSec) * 0.5;
      if (s.transitionIn.durationSec > maxT + 1e-6) warnings.push(`${label}: transition shortened to ${maxT.toFixed(2)}s to fit the scene lengths.`);
    }
    if (s.text) {
      const words = s.text.content.split(/\s+/).filter(Boolean).length;
      const readSec = s.durationSec - 0.4;
      if (words / Math.max(0.3, readSec) > 3.6) warnings.push(`${label}: on-screen text may be too long to read in ${s.durationSec.toFixed(1)}s.`);
    }
  });
  if (sb.music) {
    const m = ctx.assets.get(sb.music.assetId);
    if (!m) errors.push(`Music asset "${sb.music.assetId}" does not exist in this project.`);
    else if (m.kind !== "audio") errors.push(`Music asset "${m.originalName}" is not an audio file.`);
    else if (m.excluded) errors.push(`Music asset "${m.originalName}" was excluded by the user.`);
    else if ((m.durationSec ?? 0) <= sb.music.startSec + 1) errors.push(`Music start (${sb.music.startSec}s) is beyond the track length.`);
    else if ((m.durationSec ?? 0) - sb.music.startSec < storyboardDuration(sb) - 0.5)
      warnings.push(`The music track is shorter than the video from that start point; it will end early and fade out.`);
    if (ctx.project.silentOutput) errors.push("The project is set to silent output but the storyboard includes music.");
  }
  const total = storyboardDuration(sb);
  const target = ctx.project.durationSec;
  if (Math.abs(total - target) > durationTolerance(target)) {
    errors.push(`Total scene duration is ${total.toFixed(2)}s but ${target}s was requested (tolerance ±${durationTolerance(target).toFixed(2)}s).`);
  }
  if (total > ctx.maxOutputDurationSec) errors.push(`Total duration ${total.toFixed(1)}s exceeds the maximum of ${ctx.maxOutputDurationSec}s.`);
  if (sb.scenes.length > 1) {
    // Repetition check: transitions and motions should not be monotonous.
    const trans = sb.scenes.slice(1).map((s) => s.transitionIn.type).filter((t) => t !== "cut" && t !== "fade" && t !== "dissolve");
    const counts = new Map<string, number>();
    for (const t of trans) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) if (c >= 4 && c / Math.max(1, sb.scenes.length - 1) > 0.5) warnings.push(`The "${t}" transition is used ${c} times; consider more variety.`);
  }
  return { valid: errors.length === 0, errors, warnings, storyboard: sb };
}
