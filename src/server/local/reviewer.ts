import type { Edl, QcIssue, RevisionOp, Storyboard } from "@/lib/schemas";
import type { CreativeReview } from "../agent/steps";
import type { PlanAsset } from "../render/types";
import { decodeRaster, regionStats, rgbToHsv } from "./pixels";

/**
 * On-device creative review of a rendered video. Uses frames from the ACTUAL output plus
 * the EDL geometry. Findings are estimates and are labelled with honest certainty; only
 * confident, high-severity problems come with an automatic fix.
 */
export interface LocalReview {
  review: CreativeReview;
  fixes: RevisionOp[];
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: Box, b: Box): Box => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Where the clip's focal point lands in the output frame (fractions). */
export function focalInOutput(clip: Edl["clips"][number], W: number, H: number): { x: number; y: number } {
  const { x, y } = clip.focus;
  if (clip.fit === "cover") return { x, y }; // crop offset is proportional to the focal point
  const s = Math.min(W / clip.sourceWidth, H / clip.sourceHeight);
  const fw = clip.sourceWidth * s;
  const fh = clip.sourceHeight * s;
  return { x: ((W - fw) / 2 + x * fw) / W, y: ((H - fh) / 2 + y * fh) / H };
}

export async function reviewLocally(opts: {
  edl: Edl;
  storyboard: Storyboard | null;
  assets: Map<string, PlanAsset & { hookStrength?: number; hasAnalysis?: boolean }>;
  frames: { file: string; timeSec: number; sceneId: string | null }[];
  workDir: string;
  signal?: AbortSignal;
}): Promise<LocalReview> {
  const { edl } = opts;
  const W = edl.output.width;
  const H = edl.output.height;
  const fps = edl.output.fps;
  const issues: CreativeReview["issues"] = [];
  const fixes: RevisionOp[] = [];
  const recommendations: string[] = [];

  const rasters = [];
  for (const f of opts.frames) {
    const r = await decodeRaster(f.file, opts.workDir, { w: Math.max(32, Math.round(W / 10)), h: Math.max(32, Math.round(H / 10)), signal: opts.signal });
    rasters.push({ ...f, r });
  }

  // 1) Text covering the subject (geometry from the EDL).
  let textProblems = 0;
  for (const t of edl.texts) {
    if (!t.sceneId) continue;
    const clip = edl.clips.find((c) => c.sceneId === t.sceneId);
    if (!clip) continue;
    const asset = opts.assets.get(clip.assetId);
    const f = focalInOutput(clip, W, H);
    const subject: Box = { x0: f.x - 0.2, y0: f.y - 0.15, x1: f.x + 0.2, y1: f.y + 0.15 };
    const tb: Box = { x0: t.box.left / W, y0: t.box.top / H, x1: t.box.right / W, y1: t.box.bottom / H };
    const ratio = area(tb) > 0 ? area(inter(tb, subject)) / area(tb) : 0;
    if (ratio > 0.45) {
      textProblems++;
      const confident = Boolean(asset?.hasAnalysis) && ratio > 0.6;
      const newPos = f.y < 0.5 ? "bottom" : "top";
      issues.push({
        severity: confident ? "high" : "medium",
        description: `On-screen text "${t.lines.join(" ").slice(0, 40)}" overlaps the estimated subject area (${Math.round(ratio * 100)}% of the text box).`,
        timeSec: Math.round(((t.startSec + t.endSec) / 2) * 100) / 100,
        sceneId: t.sceneId,
        suggestedFix: `Move the text in scene ${t.sceneId} to the ${newPos} of the frame.`,
        certainty: confident ? "likely" : "uncertain",
      });
      const scene = opts.storyboard?.scenes.find((s) => s.id === t.sceneId);
      if (confident && scene?.text) fixes.push({ op: "update_scene", sceneId: scene.id, changes: { text: { ...scene.text, position: newPos } } });
    }
  }

  // 2) Readability: white text over a very bright background (measured on the render).
  for (const t of edl.texts) {
    const mid = (t.startSec + t.endSec) / 2;
    const near = rasters.reduce<(typeof rasters)[number] | null>((best, fr) => (Math.abs(fr.timeSec - mid) < Math.abs((best?.timeSec ?? 1e9) - mid) ? fr : best), null);
    if (!near || Math.abs(near.timeSec - mid) > (t.endSec - t.startSec) / 2 + 0.5) continue;
    const pad = 0.04;
    const above = regionStats(near.r, { x0: t.box.left / W, y0: Math.max(0, t.box.top / H - pad), x1: t.box.right / W, y1: t.box.top / H });
    const below = regionStats(near.r, { x0: t.box.left / W, y0: t.box.bottom / H, x1: t.box.right / W, y1: Math.min(1, t.box.bottom / H + pad) });
    const bg = (above.meanLuma + below.meanLuma) / 2;
    if (bg > 205) {
      textProblems++;
      issues.push({ severity: "medium", description: `Text "${t.lines.join(" ").slice(0, 40)}" sits on a very bright background (luma ≈ ${Math.round(bg)}), which can hurt legibility.`, timeSec: Math.round(mid * 100) / 100, sceneId: t.sceneId, suggestedFix: "Move the text to a darker part of the frame or reduce brightness in that scene.", certainty: "likely" });
    }
  }

  // 3) Consistency & composition from rendered frames.
  const stats = rasters.map((fr) => {
    const s = regionStats(fr.r, { x0: 0, y0: 0, x1: 1, y1: 1 });
    let sat = 0;
    const n = fr.r.w * fr.r.h;
    for (let i = 0; i < n; i++) sat += rgbToHsv(fr.r.data[i * 3] as number, fr.r.data[i * 3 + 1] as number, fr.r.data[i * 3 + 2] as number)[1];
    return { ...s, sat: sat / n, timeSec: fr.timeSec, sceneId: fr.sceneId };
  });
  const content = stats.filter((s) => !edl.intentional.darkRanges.some(([a, b]) => s.timeSec >= a - 0.2 && s.timeSec <= b + 0.2));
  const meanL = content.reduce((a, s) => a + s.meanLuma, 0) / Math.max(1, content.length);
  const cv = content.length > 1 ? Math.sqrt(content.reduce((a, s) => a + (s.meanLuma - meanL) ** 2, 0) / content.length) / Math.max(1, meanL) : 0;
  const flat = content.filter((s) => s.stdLuma < 10);
  for (const s of flat) issues.push({ severity: "medium", description: `The frame at ${s.timeSec.toFixed(1)}s is nearly uniform (very little visible detail).`, timeSec: s.timeSec, sceneId: s.sceneId, suggestedFix: "Check that scene's source image; consider replacing it.", certainty: "uncertain" });
  const extreme = content.filter((s) => s.meanLuma < 35 || s.meanLuma > 235);
  for (const s of extreme) issues.push({ severity: "medium", description: `The frame at ${s.timeSec.toFixed(1)}s is ${s.meanLuma < 35 ? "very dark" : "very bright"} after grading.`, timeSec: s.timeSec, sceneId: s.sceneId, suggestedFix: s.meanLuma < 35 ? "Use a brighter shot or a brighter grade (e.g. bright airy)." : "Use a less bright grade for this scene.", certainty: "likely" });

  // 4) Opening & ending.
  const firstClip = edl.clips[0];
  const firstHook = firstClip ? opts.assets.get(firstClip.assetId)?.hookStrength : undefined;
  const firstFrame = stats[0];
  let openingHook: CreativeReview["openingHook"] = firstHook === undefined ? "needs_review" : firstHook >= 4 ? "good" : firstHook === 3 ? "needs_review" : "poor";
  if (firstFrame && firstFrame.meanLuma < 30 && !edl.intentional.darkRanges.some(([a, b]) => firstFrame.timeSec >= a && firstFrame.timeSec <= b)) openingHook = "poor";
  if (openingHook === "poor") {
    issues.push({ severity: "medium", description: "The opening shot measures as a weak hook (low contrast/colour/sharpness).", timeSec: 0, sceneId: firstClip?.sceneId ?? null, suggestedFix: 'Open with a stronger shot — say "make the opening more exciting".', certainty: "uncertain" });
    recommendations.push('Try: "make the opening more exciting" to open on the strongest measured shot.');
  }
  const totalSec = edl.output.totalFrames / fps;
  const lastClip = edl.clips[edl.clips.length - 1];
  const intentionalEnd = edl.fadeOut.videoSec > 0 || edl.texts.some((t) => t.id === "end_title") || (lastClip ? lastClip.frames / fps >= 2 && lastClip.motion.type !== "none" : false);
  const ending: CreativeReview["ending"] = intentionalEnd ? "good" : "needs_review";
  if (!intentionalEnd) recommendations.push("Consider a fade-out or end card so the ending feels deliberate.");
  const visualConsistency: CreativeReview["visualConsistency"] = cv > 0.45 ? "needs_review" : "good";
  if (cv > 0.45) recommendations.push("Brightness varies a lot between scenes; a single stronger grade or fewer mismatched shots would feel more consistent.");
  const captionReadability: CreativeReview["captionReadability"] = edl.texts.length === 0 ? "not_assessed" : textProblems === 0 ? "good" : issues.some((i) => i.severity === "high") ? "poor" : "needs_review";
  const composition: CreativeReview["composition"] = flat.length || extreme.length ? "needs_review" : "good";

  const summary = `Local review of ${rasters.length} frames from the rendered file (estimates, not AI vision): opening ${openingHook.replace("_", " ")}, text ${captionReadability.replace("_", " ")}, consistency ${visualConsistency.replace("_", " ")}, ending ${ending.replace("_", " ")}. Duration ${totalSec.toFixed(1)}s.`;
  return {
    review: { openingHook, captionReadability, visualConsistency, composition, ending, summary, issues: issues.slice(0, 12), recommendations: recommendations.slice(0, 8) },
    fixes,
  };
}

export type { QcIssue };
