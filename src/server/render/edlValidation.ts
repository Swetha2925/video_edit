import fs from "node:fs";
import { EdlSchema, type Edl } from "@/lib/schemas";
import { TRANSITIONS } from "@/lib/presets";
import { resolveProjectPath } from "../storage";
import type { CompileContext, ValidationOutcome } from "./types";

/**
 * Strict EDL validation — the gate before any render. Rejects invalid asset IDs,
 * negative/zero durations, out-of-range timestamps, unsupported effects, unsafe paths,
 * and text that falls outside the platform safe area or below a readable size.
 */
export function validateEdl(input: unknown, ctx: CompileContext, projectId: string, opts: { checkFiles?: boolean } = {}): ValidationOutcome & { edl?: Edl } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = EdlSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`), warnings };
  }
  const edl = parsed.data;
  const { fps, totalFrames, width: W, height: H } = edl.output;
  const totalSec = totalFrames / fps;

  if (W !== ctx.project.width || H !== ctx.project.height) errors.push(`Output ${W}x${H} does not match project ${ctx.project.width}x${ctx.project.height}.`);
  if (fps !== ctx.project.fps) errors.push(`Output fps ${fps} does not match project fps ${ctx.project.fps}.`);
  if (totalSec > ctx.maxOutputDurationSec + 0.01) errors.push(`Output duration ${totalSec.toFixed(2)}s exceeds the ${ctx.maxOutputDurationSec}s limit.`);

  const checkPath = (rel: string, label: string) => {
    try {
      const abs = resolveProjectPath(projectId, rel);
      if (opts.checkFiles !== false && !fs.existsSync(abs)) errors.push(`${label}: source file is missing.`);
    } catch {
      errors.push(`${label}: unsafe source path.`);
    }
  };

  let expectedStart = 0;
  edl.clips.forEach((c, i) => {
    const label = `Clip ${i + 1}`;
    const a = ctx.assets.get(c.assetId);
    if (!a) errors.push(`${label}: asset ${c.assetId} is not part of this project.`);
    else {
      if (a.kind !== c.kind) errors.push(`${label}: asset kind mismatch (${a.kind} vs ${c.kind}).`);
      if (c.source !== `originals/${a.storedName}`) errors.push(`${label}: source path does not belong to asset ${c.assetId}.`);
      if (a.excluded) errors.push(`${label}: asset was excluded by the user.`);
    }
    checkPath(c.source, label);
    if (!(c.transitionIn.type in TRANSITIONS)) errors.push(`${label}: unsupported transition "${c.transitionIn.type}".`);
    if (i === 0 && c.transitionIn.frames !== 0) errors.push(`${label}: the first clip cannot have an incoming transition.`);
    if (c.transitionIn.type === "cut" && c.transitionIn.frames !== 0) errors.push(`${label}: a cut must have zero transition frames.`);
    if (c.transitionIn.type !== "cut" && c.transitionIn.frames < 2) errors.push(`${label}: transition is too short.`);
    if (c.transitionIn.frames % 2 !== 0) errors.push(`${label}: transition frames must be even.`);
    const prev = edl.clips[i - 1];
    if (prev && c.transitionIn.frames >= Math.min(prev.frames, c.frames)) errors.push(`${label}: transition is longer than an adjacent clip.`);
    const start = i === 0 ? 0 : expectedStart - c.transitionIn.frames;
    if (c.timelineStartFrame !== start) errors.push(`${label}: timeline start ${c.timelineStartFrame} ≠ expected ${start}.`);
    expectedStart = start + c.frames;
    if (c.kind === "video") {
      const d = c.sourceDurationSec ?? 0;
      if (c.inSec >= d) errors.push(`${label}: in-point ${c.inSec}s is outside the clip (${d.toFixed(2)}s).`);
      if (c.inSec + c.frames / fps > d + 0.05) warnings.push(`${label}: clip is shorter than its slot; the last frame will be held.`);
    } else if (c.inSec !== 0) {
      errors.push(`${label}: images cannot have an in-point.`);
    }
    if (c.audio.use && c.kind !== "video") errors.push(`${label}: only video clips can contribute audio.`);
  });
  if (expectedStart !== totalFrames) errors.push(`Clips cover ${expectedStart} frames but the output has ${totalFrames}.`);

  const scale = Math.min(W, H) / 1080;
  const minPx = Math.round(32 * scale);
  edl.texts.forEach((t, i) => {
    const label = `Text ${i + 1} ("${t.lines.join(" ").slice(0, 24)}")`;
    if (t.endSec <= t.startSec) errors.push(`${label}: ends before it starts.`);
    if (t.startSec < 0 || t.endSec > totalSec + 0.01) errors.push(`${label}: outside the timeline.`);
    if (t.sizePx < minPx) errors.push(`${label}: font size ${t.sizePx}px is below the readable minimum (${minPx}px).`);
    if (t.box.left < 0 || t.box.right > W || t.box.top < 0 || t.box.bottom > H) errors.push(`${label}: text extends outside the frame.`);
    else {
      const sa = edl.safeArea;
      if (t.box.left < sa.left - 2 || t.box.right > W - sa.right + 2 || t.box.top < sa.top - 2 || t.box.bottom > H - sa.bottom + 2)
        warnings.push(`${label}: text enters the platform UI area (may be covered by app buttons).`);
    }
    if (t.endSec - t.startSec < 0.8) warnings.push(`${label}: on screen for less than 0.8s.`);
  });

  if (edl.music) {
    const a = ctx.assets.get(edl.music.assetId);
    if (!a || a.kind !== "audio") errors.push("Music: asset is not an audio file in this project.");
    else if (edl.music.source !== `originals/${a.storedName}`) errors.push("Music: source path does not belong to the asset.");
    checkPath(edl.music.source, "Music");
    if (edl.music.startSec >= edl.music.sourceDurationSec) errors.push("Music: start point is beyond the track.");
    if (ctx.project.silentOutput) errors.push("Music is present but silent output was requested.");
  }
  if (ctx.project.silentOutput && edl.expectsAudio) errors.push("Silent output requested but the EDL expects audio.");

  return { valid: errors.length === 0, errors, warnings: [...warnings], edl };
}
