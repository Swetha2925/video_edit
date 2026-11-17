import type { Edl, EdlClip, EdlText, Storyboard } from "@/lib/schemas";
import { safeArea, type MotionId, type MotionIntensity } from "@/lib/presets";
import { exposureFixFor } from "./grades";
import { layoutText, styleSpec } from "./textLayout";
import type { CompileContext, PlanAsset } from "./types";

/**
 * Storyboard → EDL compiler. Claude decides *what* (scenes, assets, look, words);
 * this deterministic step decides *exactly how*: frame-accurate timing, transition
 * overlaps, beat-snapped cuts, motion paths, crop focus, exposure correction and
 * safe-area typography. Same input always yields the same EDL.
 *
 * Timing model: scene i occupies [B_i, B_{i+1}) on the output timeline. A transition
 * of T frames into scene i is centred on B_i, so clip i is rendered for
 * D_i + T_i/2 + T_{i+1}/2 frames and starts at B_i − T_i/2.
 */

const MOTION_ZOOM: Record<MotionIntensity, number> = { subtle: 0.06, medium: 0.1, strong: 0.16 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function motionParams(type: MotionId, intensity: MotionIntensity, focus: { x: number; y: number }): EdlClip["motion"] {
  const z = MOTION_ZOOM[intensity];
  const fx = clamp(focus.x, 0, 1);
  const fy = clamp(focus.y, 0, 1);
  const span = clamp(0.35 + z * 2, 0.35, 0.7);
  const lo = (c: number) => clamp(c - span / 2, 0, 1);
  const hi = (c: number) => clamp(c + span / 2, 0, 1);
  switch (type) {
    case "none":
      return { type, zoomFrom: 1, zoomTo: 1, xFrom: fx, xTo: fx, yFrom: fy, yTo: fy };
    case "push_in":
      return { type, zoomFrom: 1, zoomTo: r3(1 + z), xFrom: fx, xTo: fx, yFrom: fy, yTo: fy };
    case "pull_out":
      return { type, zoomFrom: r3(1 + z), zoomTo: 1, xFrom: fx, xTo: fx, yFrom: fy, yTo: fy };
    case "pan_left":
      return { type, zoomFrom: r3(1 + z + 0.04), zoomTo: r3(1 + z + 0.04), xFrom: hi(0.5), xTo: lo(0.5), yFrom: fy, yTo: fy };
    case "pan_right":
      return { type, zoomFrom: r3(1 + z + 0.04), zoomTo: r3(1 + z + 0.04), xFrom: lo(0.5), xTo: hi(0.5), yFrom: fy, yTo: fy };
    case "pan_up":
      return { type, zoomFrom: r3(1 + z + 0.04), zoomTo: r3(1 + z + 0.04), xFrom: fx, xTo: fx, yFrom: hi(0.5), yTo: lo(0.5) };
    case "pan_down":
      return { type, zoomFrom: r3(1 + z + 0.04), zoomTo: r3(1 + z + 0.04), xFrom: fx, xTo: fx, yFrom: lo(0.5), yTo: hi(0.5) };
    case "drift":
      return { type, zoomFrom: r3(1 + z * 0.4), zoomTo: r3(1 + z), xFrom: clamp(fx - 0.08, 0, 1), xTo: clamp(fx + 0.08, 0, 1), yFrom: clamp(fy + 0.05, 0, 1), yTo: clamp(fy - 0.05, 0, 1) };
  }
}

/** Snap interior cut boundaries (frames) to nearby beats while keeping a minimum scene length. */
export function snapBoundariesToBeats(boundaries: number[], beatsSec: number[], fps: number, total: number, opts = { windowSec: 0.3, minSceneSec: 0.8 }): number[] {
  if (beatsSec.length === 0 || boundaries.length < 3) return boundaries;
  const out = [...boundaries];
  const minF = Math.round(opts.minSceneSec * fps);
  const win = Math.round(opts.windowSec * fps);
  const beatFrames = beatsSec.map((b) => Math.round(b * fps)).filter((b) => b > 0 && b < total);
  for (let i = 1; i < out.length - 1; i++) {
    const b = out[i] as number;
    let best = b;
    let bestD = win + 1;
    for (const bf of beatFrames) {
      const d = Math.abs(bf - b);
      if (d < bestD) {
        bestD = d;
        best = bf;
      }
    }
    const prev = out[i - 1] as number;
    const next = out[i + 1] as number;
    if (bestD <= win && best - prev >= minF && next - best >= minF) out[i] = best;
  }
  return out;
}

export interface CompileResult {
  edl: Edl;
  warnings: string[];
}

export function compileStoryboard(sb: Storyboard, ctx: CompileContext): CompileResult {
  const { project } = ctx;
  const fps = project.fps;
  const W = project.width;
  const H = project.height;
  const warnings: string[] = [];
  const safe = safeArea(project.platform, W, H);
  // Global text size multiplier; never shrinks below a readable floor.
  const k = sb.textScale ?? 1;
  const sized = (sp: ReturnType<typeof styleSpec>) => ({ ...sp, basePx: Math.round(sp.basePx * k), minPx: Math.max(34, Math.round(sp.minPx * Math.min(1, k))) });

  // 1. Scene boundaries in frames (cumulative rounding avoids drift).
  const boundaries: number[] = [0];
  let acc = 0;
  for (const s of sb.scenes) {
    acc += s.durationSec;
    boundaries.push(Math.round(acc * fps));
  }
  const totalFrames = boundaries[boundaries.length - 1] as number;

  // 2. Optional beat sync.
  const musicAsset = sb.music && !project.silentOutput ? ctx.assets.get(sb.music.assetId) : undefined;
  let bounds = boundaries;
  if (sb.music && musicAsset && sb.music.beatSync) {
    const beats = (musicAsset.beats ?? []).map((b) => b - (sb.music?.startSec ?? 0)).filter((b) => b > 0);
    if (beats.length > 0) {
      bounds = snapBoundariesToBeats(boundaries, beats, fps, totalFrames);
      const moved = bounds.filter((b, i) => b !== boundaries[i]).length;
      if (moved > 0) warnings.push(`Snapped ${moved} cut${moved === 1 ? "" : "s"} to the music beat.`);
    } else {
      warnings.push("Beat sync requested but no reliable beat grid was detected in the music; cuts keep planned timing.");
    }
  }
  const D = sb.scenes.map((_, i) => (bounds[i + 1] as number) - (bounds[i] as number));

  // 3. Transition frames (even numbers, ≤ half of each neighbouring scene).
  const T = sb.scenes.map((s, i) => {
    if (i === 0 || s.transitionIn.type === "cut" || s.transitionIn.durationSec <= 0) return 0;
    let f = Math.round(s.transitionIn.durationSec * fps);
    const maxF = Math.floor(Math.min(D[i] as number, D[i - 1] as number) * 0.5);
    f = Math.min(f, maxF);
    f -= f % 2;
    return f >= 2 ? f : 0;
  });

  const clips: EdlClip[] = [];
  const texts: EdlText[] = [];
  const darkRanges: [number, number][] = [];
  const staticRanges: [number, number][] = [];
  let anyClipAudio = false;

  sb.scenes.forEach((s, i) => {
    const asset = ctx.assets.get(s.assetId) as PlanAsset;
    const tin = T[i] as number;
    const tout = i + 1 < T.length ? (T[i + 1] as number) : 0;
    const frames = (D[i] as number) + tin / 2 + tout / 2;
    const start = (bounds[i] as number) - tin / 2;
    let inSec = 0;
    if (asset.kind === "video") {
      const srcDur = asset.durationSec ?? 0;
      inSec = Math.max(0, s.sourceInSec - tin / 2 / fps);
      const need = frames / fps;
      if (inSec + need > srcDur - 0.04) {
        inSec = Math.max(0, srcDur - need - 0.04);
        if (srcDur - 0.04 < need) {
          warnings.push(`Scene ${i + 1}: clip is ${srcDur.toFixed(2)}s but ${need.toFixed(2)}s is needed; the final frame will be held.`);
          staticRanges.push([r3((start + Math.floor(srcDur * fps)) / fps), r3((start + frames) / fps)]);
        }
      }
    }
    const focus = s.focus ?? asset.focalPoint ?? { x: 0.5, y: 0.45 };
    const motion = motionParams(s.motion, s.motionIntensity, focus);
    if (asset.kind === "image" && s.motion === "none") staticRanges.push([r3(start / fps), r3((start + frames) / fps)]);
    const sw = asset.width ?? W;
    const sh = asset.height ?? H;
    const zoomMax = Math.max(motion.zoomFrom, motion.zoomTo);
    const coverScale = Math.max(W / sw, H / sh) * zoomMax;
    const containScale = Math.min(W / sw, H / sh) * zoomMax;
    const upscaled = (s.fit === "cover" ? coverScale : containScale) > 1.05;
    const useAudio = !project.silentOutput && s.useClipAudio && asset.kind === "video" && asset.hasAudio && s.clipAudioVolume > 0;
    if (useAudio) anyClipAudio = true;
    if (tin > 0 && s.transitionIn.type === "fade_black") darkRanges.push([r3(start / fps), r3((start + tin) / fps)]);
    clips.push({
      id: `c${i + 1}`,
      sceneId: s.id,
      assetId: asset.id,
      kind: asset.kind === "video" ? "video" : "image",
      source: `originals/${asset.storedName}`,
      sourceWidth: sw,
      sourceHeight: sh,
      sourceDurationSec: asset.kind === "video" ? asset.durationSec : null,
      inSec: r3(inSec),
      frames,
      timelineStartFrame: start,
      fit: s.fit,
      focus,
      motion,
      grade: { preset: sb.colorGrade, intensity: sb.gradeIntensity, exposureFix: exposureFixFor(asset.brightness) },
      transitionIn: { type: tin > 0 ? s.transitionIn.type : "cut", frames: tin },
      audio: { use: useAudio, volume: useAudio ? s.clipAudioVolume : 0 },
      upscaled,
    });

    if (s.text) {
      const spec = sized(styleSpec(s.text.style, sb.typography));
      const lay = layoutText(s.text.content, spec, s.text.position, { width: W, height: H }, safe);
      const sStart = (bounds[i] as number) / fps + (i === 0 ? 0.25 : Math.min(0.3, tin / fps / 2 + 0.1));
      const sEnd = (bounds[i + 1] as number) / fps - (i === sb.scenes.length - 1 ? 0.3 : 0.15);
      if (sEnd - sStart < 1.0) warnings.push(`Scene ${i + 1}: text is visible for only ${(sEnd - sStart).toFixed(1)}s.`);
      if (!lay.fits) warnings.push(`Scene ${i + 1}: text "${s.text.content.slice(0, 30)}…" is too long to fit the safe area at a readable size.`);
      texts.push({
        id: `t${i + 1}`,
        sceneId: s.id,
        lines: lay.lines.map((l) => l.slice(0, 60)).slice(0, 4),
        startSec: r3(sStart),
        endSec: r3(Math.max(sStart + 0.5, sEnd)),
        font: spec.font,
        sizePx: lay.sizePx,
        bold: spec.bold,
        italic: spec.italic,
        uppercase: spec.uppercase,
        spacingPx: Math.round(spec.spacingPx * (Math.min(W, H) / 1080)),
        color: "#FFFFFF",
        x: lay.x,
        y: lay.y,
        align: lay.align,
        animation: s.text.animation,
        boxed: s.text.style === "label",
        fadeInMs: 450,
        fadeOutMs: 350,
        box: lay.box,
      });
    }
  });

  const totalSec = totalFrames / fps;
  const fadeVideo = sb.fadeOutEnding ? Math.min(0.8, totalSec * 0.05) : 0;
  if (fadeVideo > 0) darkRanges.push([r3(totalSec - fadeVideo), r3(totalSec)]);
  // A fade-in from black at the very start if the first scene asks for a fade.
  const first = sb.scenes[0];
  let fadeInSec = 0;
  if (first && (first.transitionIn.type === "fade_black" || first.transitionIn.type === "fade") && first.transitionIn.durationSec > 0) {
    fadeInSec = r3(Math.min(first.transitionIn.durationSec, 1, (D[0] as number) / fps / 3));
    darkRanges.push([0, fadeInSec]);
  }

  // End card over the final seconds.
  if (sb.endCard) {
    const ecStart = Math.max(((bounds[bounds.length - 2] as number) / fps) + 0.3, totalSec - 3.2);
    const ecEnd = totalSec - Math.max(0.2, fadeVideo * 0.5);
    const last = texts[texts.length - 1];
    if (last && last.endSec > ecStart - 0.1 && last.sceneId === sb.scenes[sb.scenes.length - 1]?.id) {
      last.endSec = r3(Math.max(last.startSec + 0.5, ecStart - 0.2));
      if (last.endSec >= ecStart) texts.pop();
    }
    const titleSpec = sized(styleSpec("title", sb.typography));
    const lay = layoutText(sb.endCard.text, titleSpec, "center", { width: W, height: H }, safe);
    texts.push({
      id: "end_title",
      sceneId: null,
      lines: lay.lines.slice(0, 4),
      startSec: r3(ecStart),
      endSec: r3(ecEnd),
      font: titleSpec.font,
      sizePx: lay.sizePx,
      bold: titleSpec.bold,
      italic: titleSpec.italic,
      uppercase: titleSpec.uppercase,
      spacingPx: titleSpec.spacingPx,
      color: "#FFFFFF",
      x: lay.x,
      y: lay.y,
      align: lay.align,
      animation: "fade_scale",
      boxed: false,
      fadeInMs: 600,
      fadeOutMs: 400,
      box: lay.box,
    });
    if (sb.endCard.subtext) {
      const subSpec = sized(styleSpec("kicker", sb.typography));
      const subLay = layoutText(sb.endCard.subtext, subSpec, "center", { width: W, height: H }, safe);
      const offset = Math.round(lay.box.bottom - lay.y + subLay.sizePx * 1.1);
      texts.push({
        id: "end_sub",
        sceneId: null,
        lines: subLay.lines.slice(0, 4),
        startSec: r3(ecStart + 0.35),
        endSec: r3(ecEnd),
        font: subSpec.font,
        sizePx: subLay.sizePx,
        bold: subSpec.bold,
        italic: false,
        uppercase: subSpec.uppercase,
        spacingPx: Math.round(subSpec.spacingPx * (Math.min(W, H) / 1080)),
        color: "#FFFFFF",
        x: subLay.x,
        y: subLay.y + offset,
        align: "center",
        animation: "rise",
        boxed: false,
        fadeInMs: 500,
        fadeOutMs: 400,
        box: { ...subLay.box, top: subLay.box.top + offset, bottom: subLay.box.bottom + offset },
      });
    }
  }

  let music: Edl["music"] = null;
  if (sb.music && musicAsset && musicAsset.kind === "audio" && musicAsset.durationSec) {
    const available = musicAsset.durationSec - sb.music.startSec;
    music = {
      assetId: musicAsset.id,
      source: `originals/${musicAsset.storedName}`,
      startSec: sb.music.startSec,
      sourceDurationSec: musicAsset.durationSec,
      volume: sb.music.volume,
      fadeInSec: sb.music.startSec > 0.5 ? 0.6 : 0.15,
      fadeOutSec: r3(Math.min(2.5, totalSec * 0.12, Math.max(0.5, available))),
      duckUnderClipAudio: anyClipAudio,
    };
  }

  const upscaledCount = clips.filter((c) => c.upscaled).length;
  if (upscaledCount > 0) warnings.push(`${upscaledCount} clip${upscaledCount === 1 ? " is" : "s are"} upscaled from lower-resolution sources (no real detail is added).`);

  const edl: Edl = {
    schemaVersion: 1,
    output: { width: W, height: H, fps, totalFrames, videoCodec: "h264", audioCodec: "aac", pixFmt: "yuv420p", crf: ctx.render.crf, preset: ctx.render.preset },
    platform: project.platform,
    safeArea: safe,
    clips,
    texts,
    music,
    fadeIn: { videoSec: fadeInSec },
    fadeOut: { videoSec: r3(fadeVideo), audioSec: music ? music.fadeOutSec : anyClipAudio ? 0.5 : 0 },
    loudness: { targetLufs: -14, truePeakDb: -1.5 },
    intentional: { darkRanges, staticRanges },
    expectsAudio: !project.silentOutput && (music !== null || anyClipAudio),
    warnings,
  };
  return { edl, warnings };
}
