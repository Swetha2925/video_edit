import type { Scene, Storyboard } from "@/lib/schemas";
import { STYLES, type MotionId, type StyleId, type TransitionId } from "@/lib/presets";
import type { AgentAsset } from "./context";

/**
 * "Basic assembly (no AI)": a deterministic, clearly-labelled planner used when Claude is
 * not configured. It orders the selected media, gives each shot a gentle motion and
 * crossfade, and applies the style preset's look. It makes no creative claims about
 * content because it cannot see it — but it uses deterministic quality metrics to avoid
 * opening on a dark or blurry shot.
 */
const MOTION_CYCLE: MotionId[] = ["push_in", "pan_right", "pull_out", "pan_left", "drift", "pan_up"];

function qualityScore(a: AgentAsset): number {
  let s = 0;
  const px = (a.width ?? 0) * (a.height ?? 0);
  s += Math.min(1, px / (1080 * 1350));
  if (a.metrics?.veryDark) s -= 1.2;
  else if (a.metrics?.dark) s -= 0.5;
  if (a.metrics?.blurry) s -= 1;
  else if (a.metrics?.soft) s -= 0.3;
  return s;
}

export function heuristicStoryboard(opts: {
  projectName: string;
  style: StyleId;
  durationSec: number;
  width: number;
  height: number;
  captionsEnabled: boolean;
  silentOutput: boolean;
  assets: AgentAsset[];
}): Storyboard {
  const visuals = opts.assets.filter((a) => !a.excluded && (a.kind === "image" || a.kind === "video"));
  if (visuals.length === 0) throw new Error("Add at least one photo or video clip to assemble a video.");
  const preset = STYLES[opts.style];
  // Opening shot: best measured quality; the rest keep upload order.
  const best = [...visuals].sort((a, b) => qualityScore(b) - qualityScore(a))[0] as AgentAsset;
  const ordered = [best, ...visuals.filter((a) => a.id !== best.id)];
  const minShot = preset.pacing === "fast" ? 1.2 : preset.pacing === "slow" ? 3 : 2;
  const maxShots = Math.max(1, Math.floor(opts.durationSec / minShot));
  let picked = ordered.slice(0, maxShots);
  // If few assets for a long video, cycle through them (max 30 s per scene).
  while (opts.durationSec / picked.length > 30) picked = [...picked, ...ordered].slice(0, picked.length + ordered.length);
  const per = Math.round((opts.durationSec / picked.length) * 100) / 100;
  const outVertical = opts.height > opts.width;
  const transition: TransitionId = preset.transitions.includes("fade" as never) ? "fade" : "dissolve";
  const scenes: Scene[] = picked.map((a, i) => {
    const landscape = (a.width ?? 1) > (a.height ?? 1) * 1.05;
    const isVideo = a.kind === "video";
    const dur = i === picked.length - 1 ? Math.round((opts.durationSec - per * (picked.length - 1)) * 100) / 100 : per;
    const srcDur = a.durationSec ?? 0;
    return {
      id: `s${i + 1}`,
      purpose: i === 0 ? "Opening (best-quality shot)" : i === picked.length - 1 ? "Closing" : "Sequence",
      durationSec: dur,
      assetId: a.id,
      sourceInSec: isVideo ? Math.max(0, Math.min(srcDur * 0.2, srcDur - dur - 0.1)) : 0,
      fit: outVertical && landscape ? "contain_blur" : "cover",
      focus: null,
      motion: isVideo ? "none" : (MOTION_CYCLE[i % MOTION_CYCLE.length] as MotionId),
      motionIntensity: "subtle",
      transitionIn: i === 0 ? { type: "fade", durationSec: 0.6 } : { type: transition, durationSec: Math.min(0.6, dur / 3) },
      text: i === 0 && opts.captionsEnabled ? { content: opts.projectName.slice(0, 60), style: "title", position: "lower_third", animation: "rise" } : null,
      useClipAudio: false,
      clipAudioVolume: 0,
      visualDescription: `${a.kind} "${a.originalName}"`,
      musicCue: "",
      reason: "Basic assembly: upload order with the best-measured shot first.",
    };
  });
  const music = !opts.silentOutput ? opts.assets.find((a) => a.kind === "audio" && !a.excluded) : undefined;
  return {
    title: opts.projectName.slice(0, 120),
    logline: "Basic assembly generated without AI analysis.",
    colorGrade: preset.grade,
    gradeIntensity: 0.7,
    typography: preset.typography,
    music: music ? { assetId: music.id, startSec: 0, volume: 0.9, beatSync: true } : null,
    endCard: null,
    fadeOutEnding: true,
    scenes,
  };
}
