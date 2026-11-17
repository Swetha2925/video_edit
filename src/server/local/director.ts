import type { CreativeBrief, Scene, SceneText, Storyboard } from "@/lib/schemas";
import { STYLES, type MotionId, type MotionIntensity, type StyleId, type TransitionId } from "@/lib/presets";
import type { AgentAsset, AgentProject } from "../agent/context";
import { normalizeDurations } from "../render/storyboardValidation";
import { callToActionFrom } from "./brief";

/**
 * On-device creative director. Uses the brief plus measured asset analysis to build a
 * storyboard with a deliberate structure:
 *   hook (strongest measured shot) → establishing → build (varied, colour-aware order)
 *   → emotional peak (longest hold) → closing (calm/warm frame) → optional CTA end card.
 * Motion is aimed at each shot's focal point; transitions are restrained and varied; text
 * comes only from the user's own words and is placed away from the subject.
 */

interface Candidate {
  a: AgentAsset;
  hook: number; // 1–5
  quality: number; // 0–3
  warmth: number;
  vivid: number;
  establishing: boolean;
  colorKey: string;
}

const AVG_SHOT: Record<CreativeBrief["pacing"], number> = { slow: 3.6, medium: 2.6, fast: 1.6, dynamic: 2.0 };
const TRANS_SEC: Record<CreativeBrief["pacing"], number> = { slow: 0.8, medium: 0.55, fast: 0.3, dynamic: 0.4 };

function candidate(a: AgentAsset): Candidate {
  const an = a.analysis;
  const qmap = { excellent: 3, good: 2, fair: 1, poor: 0 } as const;
  const m = a.metrics;
  let quality = an ? qmap[an.visualQuality] : 2;
  if (!an && m) quality = m.blurry || m.veryDark ? 0 : m.soft || m.dark ? 1 : 2;
  const warm = an?.dominantColors.some((c) => /orange|gold|yellow|red|cream|beige|pink|brown/.test(c)) ? 1 : 0;
  const vivid = an?.summary.includes("vivid") ? 1 : 0;
  return {
    a,
    hook: an?.hookStrength ?? Math.max(1, Math.min(5, 1 + quality + (m && m.brightness > 80 && m.brightness < 200 ? 1 : 0))),
    quality,
    warmth: warm,
    vivid,
    establishing: Boolean(an?.storyRoles.includes("establishing")),
    colorKey: an?.dominantColors[0] ?? "unknown",
  };
}

function focusOf(a: AgentAsset) {
  return a.analysis?.focalPoint ?? { x: 0.5, y: 0.45 };
}

/** Choose a camera move that travels toward the subject and differs from the previous move. */
function chooseMotion(a: AgentAsset, prev: MotionId | null, role: "hook" | "peak" | "closing" | "build"): MotionId {
  if (a.kind === "video") return "none";
  const f = focusOf(a);
  const options: MotionId[] = [];
  if (role === "hook") options.push("push_in");
  if (role === "peak") options.push("push_in", "drift");
  if (role === "closing") options.push("pull_out");
  if (f.x < 0.4) options.push("pan_left");
  if (f.x > 0.6) options.push("pan_right");
  if (f.y < 0.38) options.push("pan_up");
  if (f.y > 0.62) options.push("pan_down");
  options.push("push_in", "pull_out", "drift");
  return options.find((o) => o !== prev) ?? "drift";
}

function textPosition(a: AgentAsset): SceneText["position"] {
  const f = focusOf(a);
  return f.y < 0.5 ? "lower_third" : "top";
}

export function createLocalStoryboard(opts: { project: AgentProject; brief: CreativeBrief; assets: AgentAsset[] }): Storyboard {
  const { project, brief } = opts;
  const style = (project.style in STYLES ? project.style : "cinematic_travel") as StyleId;
  const preset = STYLES[style];
  const visuals = opts.assets.filter((a) => !a.excluded && (a.kind === "image" || a.kind === "video"));
  if (visuals.length === 0) throw new Error("Add at least one photo or video clip to plan a video.");
  const D = brief.durationSec || project.durationSec;
  const avoidFlashy = brief.avoid.some((x) => /flash|transition|effect|zoom|gimmick/i.test(x)) || /not (overly )?flashy|subtle|restrained|minimal/i.test(project.prompt);

  // 1) Rank. Drop poor shots when there are enough good ones.
  let pool = visuals.map(candidate);
  const good = pool.filter((c) => c.quality > 0);
  const avg = AVG_SHOT[brief.pacing];
  let n = Math.max(1, Math.round(D / avg));
  if (good.length >= Math.min(n, 3)) pool = good;
  n = Math.min(n, Math.max(pool.length, Math.floor(D / Math.max(1.2, avg * 0.7))));
  n = Math.max(1, Math.min(n, Math.floor(D / 0.8), 60));

  const byHook = [...pool].sort((x, y) => y.hook - x.hook || y.quality - x.quality);
  const hook = byHook[0] as Candidate;
  const rest = pool.filter((c) => c !== hook);
  const peak = [...rest].sort((x, y) => y.vivid + y.warmth + y.hook / 5 - (x.vivid + x.warmth + x.hook / 5))[0];
  const closing = [...rest].filter((c) => c !== peak).sort((x, y) => y.warmth - x.warmth || y.quality - x.quality || x.hook - y.hook)[0];
  const middle = rest.filter((c) => c !== peak && c !== closing);
  // Establishing shots first, then alternate colour families to keep variety.
  middle.sort((x, y) => Number(y.establishing) - Number(x.establishing));
  const ordered: Candidate[] = [];
  const remaining = [...middle];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    const idx = remaining.findIndex((c) => !last || c.colorKey !== last.colorKey);
    ordered.push(...remaining.splice(idx >= 0 ? idx : 0, 1));
  }
  let seq: Candidate[] = [hook, ...ordered];
  if (peak) seq.push(peak);
  if (closing) seq.push(closing);
  // Fit to n shots: trim from the middle (keep hook, peak, closing) or extend by reusing.
  while (seq.length > n && seq.length > 3) seq.splice(Math.max(1, seq.length - 3), 1);
  if (seq.length > n) seq = seq.slice(0, n);
  const reuse = [...pool].sort((x, y) => Number(y.a.kind === "video") - Number(x.a.kind === "video") || y.hook - x.hook);
  let ri = 0;
  while (seq.length < n && reuse.length) {
    const c = reuse[ri % reuse.length] as Candidate;
    ri++;
    const insertAt = Math.max(1, seq.length - (peak ? 2 : 1));
    if (reuse.length > 1 && (seq[insertAt - 1]?.a.id === c.a.id || seq[insertAt]?.a.id === c.a.id)) {
      if (ri > reuse.length * 3) break;
      continue;
    }
    seq.splice(insertAt, 0, c);
  }

  // 2) Durations: hook a touch shorter (fast) or standard, peak and closing longer.
  const raw = seq.map((c, i) => {
    let d = avg;
    if (i === 0) d = brief.pacing === "fast" ? avg * 1.1 : avg * 0.95;
    if (c === peak && i > 0) d = avg * 1.45;
    if (i === seq.length - 1 && seq.length > 1) d = avg * 1.3;
    if (c.a.kind === "video") d = Math.min(d * 1.1, Math.max(1, (c.a.durationSec ?? d) - 0.2));
    return d;
  });

  // 3) Transitions: mostly cut/fade, stylised only at story beats, never back-to-back.
  const palette = (preset.transitions as readonly TransitionId[]).filter((t) => !avoidFlashy || t === "cut" || t === "fade" || t === "dissolve");
  const base: TransitionId = palette.includes("fade") ? "fade" : palette.includes("dissolve") ? "dissolve" : palette[0] ?? "cut";
  const stylised = palette.filter((t) => !["cut", "fade", "dissolve"].includes(t));
  const intensity: MotionIntensity = avoidFlashy ? "subtle" : (preset.motion as MotionIntensity);
  const usedVideoIn = new Map<string, number>();
  const scenes: Scene[] = [];
  let prevMotion: MotionId | null = null;
  let lastStylised = -10;
  const cta = callToActionFrom(project.prompt);
  const captionPool = project.captionsEnabled ? [...brief.requiredText] : [];

  seq.forEach((c, i) => {
    const role = i === 0 ? "hook" : c === peak ? "peak" : i === seq.length - 1 ? "closing" : "build";
    const motion = chooseMotion(c.a, prevMotion, role);
    prevMotion = motion;
    let tType: TransitionId = i === 0 ? (["cinematic_travel", "emotional_memories", "documentary", "minimal_aesthetic"].includes(style) ? "fade" : "cut") : base;
    if (i > 0 && stylised.length && !avoidFlashy && (role === "peak" || (i - lastStylised >= 4 && i % 4 === 0))) {
      tType = stylised[(i / 2) % stylised.length | 0] as TransitionId;
      lastStylised = i;
    }
    if (i > 0 && brief.pacing === "fast" && role === "build" && i % 2 === 1 && palette.includes("cut")) tType = "cut";
    // Video in-point: start at the strongest analysed moment, different for reuse.
    let sourceInSec = 0;
    if (c.a.kind === "video") {
      const moments = (c.a.analysis?.moments ?? []).filter((m) => m.quality !== "weak").sort((x, y) => (y.quality === "strong" ? 1 : 0) - (x.quality === "strong" ? 1 : 0));
      const k = usedVideoIn.get(c.a.id) ?? 0;
      usedVideoIn.set(c.a.id, k + 1);
      const dur = c.a.durationSec ?? 0;
      const m = moments[k % Math.max(1, moments.length)];
      sourceInSec = Math.max(0, Math.min(m ? m.startSec : (dur * (0.15 + 0.3 * k)) % Math.max(0.1, dur), Math.max(0, dur - (raw[i] as number) - 0.15)));
      sourceInSec = Math.round(sourceInSec * 100) / 100;
    }
    const landscape = (c.a.width ?? 1) > (c.a.height ?? 1) * 1.05;
    const vertical = project.height > project.width;
    const cropOk = c.a.analysis ? c.a.analysis.verticalCropSuitability === "good" : !landscape;
    let text: SceneText | null = null;
    if (project.captionsEnabled) {
      if (i === 0 && brief.title) text = { content: brief.title.slice(0, 60), style: "title", position: textPosition(c.a), animation: avoidFlashy ? "fade" : "rise" };
      else if (i > 0 && role !== "closing" && captionPool.length && i % 2 === 1) text = { content: (captionPool.shift() as string).slice(0, 120), style: "caption", position: textPosition(c.a), animation: "fade" };
    }
    const reasons: Record<string, string> = {
      hook: `Opens on the strongest shot (hook ${c.hook}/5${c.a.analysis ? `, ${c.a.analysis.summary.replace(/^Measured: /, "").split(";")[0]}` : ""}) to stop the scroll.`,
      peak: "Emotional peak: the most vivid, warm frame gets the longest hold with gentle motion.",
      closing: "Closing on a calmer, warmer frame so the ending feels intentional.",
      build: c.a.kind === "video" ? `Adds real movement from the clip's ${sourceInSec > 0 ? "strongest section" : "opening"} to build rhythm.` : "Builds the journey; colour family alternates with neighbours for variety.",
    };
    scenes.push({
      id: `s${i + 1}`,
      purpose: role === "hook" ? "Hook" : role === "peak" ? "Emotional peak" : role === "closing" ? "Memorable finish" : i === 1 ? "Establish" : "Build",
      durationSec: Math.round((raw[i] as number) * 100) / 100,
      assetId: c.a.id,
      sourceInSec,
      fit: vertical && landscape && !cropOk ? "contain_blur" : "cover",
      focus: c.a.analysis?.focalPoint ?? null,
      motion,
      motionIntensity: role === "peak" || role === "closing" ? "subtle" : intensity,
      transitionIn: { type: tType, durationSec: tType === "cut" ? 0 : i === 0 ? 0.6 : TRANS_SEC[brief.pacing] * (role === "peak" ? 1.4 : 1) },
      text,
      useClipAudio: c.a.kind === "video" && c.a.hasAudio && /\b(natural|original|ambient) (sound|audio)\b|\bkeep (the )?audio\b/i.test(project.prompt) && !project.silentOutput,
      clipAudioVolume: 0.6,
      visualDescription: `${c.a.kind === "video" ? "Clip" : "Photo"} "${c.a.originalName}"${c.a.analysis ? ` — ${c.a.analysis.summary.replace(/^Measured: /, "")}` : ""}`.slice(0, 400),
      musicCue: role === "hook" ? "Music in" : role === "peak" ? "Musical high point" : role === "closing" ? "Music resolves and fades" : "",
      reason: reasons[role] as string,
    });
  });

  const music = !project.silentOutput ? opts.assets.find((a) => a.kind === "audio" && !a.excluded) : undefined;
  let musicStart = 0;
  if (music?.audio) {
    // Skip a quiet intro: start where the track first reaches meaningful energy.
    const idx = music.audio.energy.findIndex((e) => e > 0.25);
    if (idx > 2) musicStart = Math.max(0, idx * 0.5 - 0.5);
    if ((music.durationSec ?? 0) - musicStart < D) musicStart = 0;
  }
  const sb: Storyboard = {
    title: brief.title.slice(0, 120),
    logline: brief.story.slice(0, 400),
    colorGrade: brief.colorGrade,
    gradeIntensity: brief.colorGrade === "natural" ? 0.55 : avoidFlashy ? 0.6 : 0.75,
    typography: brief.typography,
    music: music ? { assetId: music.id, startSec: Math.round(musicStart * 100) / 100, volume: 0.9, beatSync: Boolean(music.audio?.bpm) } : null,
    endCard: cta && project.captionsEnabled ? { text: cta.slice(0, 80), subtext: null } : null,
    fadeOutEnding: !["energetic_montage", "event_highlights"].includes(style),
    scenes,
  };
  return normalizeDurations(sb, D).storyboard;
}
