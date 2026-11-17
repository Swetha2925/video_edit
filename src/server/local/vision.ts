import type { AssetAnalysis } from "@/lib/schemas";
import type { VisualMetrics } from "../media/derive";
import { decodeRaster, dominantColors, luma, rgbToHsv, type Raster } from "./pixels";

/**
 * On-device visual analysis (no AI vision, no network). It MEASURES light, colour,
 * contrast, detail and where visual attention concentrates (a saliency map from edges and
 * colour distinctness). It does NOT identify objects, people or places, and says so.
 */
export interface FrameFeatures {
  brightness: number; // 0–255
  contrast: number; // luma std
  saturation: number; // 0–1
  colorfulness: number; // Hasler–Süsstrunk
  warmth: number; // mean(R−B)
  detail: number; // mean gradient magnitude
  focal: { x: number; y: number };
  concentration: number; // share of salient mass near the focal point (0–1)
  /** Share of salient mass that fits inside a 9:16 window centred on the focal point. */
  verticalFit: number;
  colors: { name: string; weight: number }[];
  aspect: number; // source width / height
}

function saliencyMap(r: Raster): Float64Array {
  const { w, h, data } = r;
  const L = new Float64Array(w * h);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < w * h; i++) {
    const R = data[i * 3] as number;
    const G = data[i * 3 + 1] as number;
    const B = data[i * 3 + 2] as number;
    L[i] = luma(R, G, B);
    mr += R;
    mg += G;
    mb += B;
  }
  mr /= w * h;
  mg /= w * h;
  mb /= w * h;
  const s = new Float64Array(w * h);
  let gmax = 1e-6;
  let cmax = 1e-6;
  const grad = new Float64Array(w * h);
  const dist = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (L[i - w + 1] as number) + 2 * (L[i + 1] as number) + (L[i + w + 1] as number) - (L[i - w - 1] as number) - 2 * (L[i - 1] as number) - (L[i + w - 1] as number);
      const gy = (L[i + w - 1] as number) + 2 * (L[i + w] as number) + (L[i + w + 1] as number) - (L[i - w - 1] as number) - 2 * (L[i - w] as number) - (L[i - w + 1] as number);
      grad[i] = Math.hypot(gx, gy);
      if ((grad[i] as number) > gmax) gmax = grad[i] as number;
    }
  for (let i = 0; i < w * h; i++) {
    const d = Math.sqrt(2 * ((data[i * 3] as number) - mr) ** 2 + 4 * ((data[i * 3 + 1] as number) - mg) ** 2 + 3 * ((data[i * 3 + 2] as number) - mb) ** 2);
    dist[i] = d;
    if (d > cmax) cmax = d;
  }
  for (let i = 0; i < w * h; i++) s[i] = 0.55 * ((grad[i] as number) / gmax) + 0.45 * ((dist[i] as number) / cmax);
  // Two passes of 3×3 box blur to turn edge noise into regions.
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float64Array(s);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += t[(y + dy) * w + x + dx] as number;
        s[y * w + x] = acc / 9;
      }
  }
  return s;
}

export function frameFeatures(r: Raster, sourceAspect: number): FrameFeatures {
  const { w, h, data } = r;
  const n = w * h;
  let sl = 0;
  let sl2 = 0;
  let ss = 0;
  let rg = 0;
  let rg2 = 0;
  let yb = 0;
  let yb2 = 0;
  let warm = 0;
  for (let i = 0; i < n; i++) {
    const R = data[i * 3] as number;
    const G = data[i * 3 + 1] as number;
    const B = data[i * 3 + 2] as number;
    const l = luma(R, G, B);
    sl += l;
    sl2 += l * l;
    ss += rgbToHsv(R, G, B)[1];
    const a = R - G;
    const b = 0.5 * (R + G) - B;
    rg += a;
    rg2 += a * a;
    yb += b;
    yb2 += b * b;
    warm += R - B;
  }
  const mean = sl / n;
  const contrast = Math.sqrt(Math.max(0, sl2 / n - mean * mean));
  const srg = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2));
  const syb = Math.sqrt(Math.max(0, yb2 / n - (yb / n) ** 2));
  const colorfulness = Math.sqrt(srg * srg + syb * syb) + 0.3 * Math.sqrt((rg / n) ** 2 + (yb / n) ** 2);

  const sal = saliencyMap(r);
  const vals = [...sal].sort((a, b) => a - b);
  const thr = vals[Math.floor(vals.length * 0.8)] ?? 0;
  const med = vals[Math.floor(vals.length * 0.5)] ?? 0;
  let cx = 0;
  let cy = 0;
  let cw = 0;
  let detail = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = sal[y * w + x] as number;
      detail += v;
      if (v >= thr) {
        cx += (x + 0.5) * v;
        cy += (y + 0.5) * v;
        cw += v;
      }
    }
  const focal = cw > 0 ? { x: cx / cw / w, y: cy / cw / h } : { x: 0.5, y: 0.5 };
  let near = 0;
  let total = 0;
  let inWin = 0;
  // 9:16 window width as a fraction of the source width (1 if the source is already narrow).
  const winFrac = Math.min(1, (9 / 16) / sourceAspect);
  const wx0 = Math.min(Math.max(0, focal.x - winFrac / 2), 1 - winFrac);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (sal[y * w + x] as number) - med;
      if (v <= 0) continue;
      total += v;
      const fx = (x + 0.5) / w;
      const fy = (y + 0.5) / h;
      if (Math.hypot(fx - focal.x, (fy - focal.y) * 1) < 0.22) near += v;
      if (fx >= wx0 && fx <= wx0 + winFrac) inWin += v;
    }
  return {
    brightness: Math.round(mean * 10) / 10,
    contrast: Math.round(contrast * 10) / 10,
    saturation: Math.round((ss / n) * 1000) / 1000,
    colorfulness: Math.round(colorfulness * 10) / 10,
    warmth: Math.round((warm / n) * 10) / 10,
    detail: Math.round((detail / n) * 1000) / 1000,
    focal: { x: Math.round(focal.x * 1000) / 1000, y: Math.round(focal.y * 1000) / 1000 },
    concentration: total > 0 ? Math.round((near / total) * 1000) / 1000 : 0,
    verticalFit: total > 0 ? Math.round((inWin / total) * 1000) / 1000 : 1,
    colors: dominantColors(r, 4).map((c) => ({ name: c.name, weight: Math.round(c.weight * 100) / 100 })),
    aspect: sourceAspect,
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 0–1 "how strong is this as an opening shot", from measurable properties. */
export function hookScore(f: FrameFeatures, metrics?: VisualMetrics): number {
  const sharp = metrics ? clamp01((12 - metrics.blur) / 7) : 0.6;
  let s = 0.32 * clamp01(f.colorfulness / 75) + 0.22 * clamp01(f.contrast / 62) + 0.26 * sharp + 0.2 * clamp01(f.concentration / 0.45);
  if (f.brightness < 40) s -= 0.35;
  else if (f.brightness < 60) s -= 0.15;
  if (f.brightness > 225) s -= 0.15;
  return clamp01(s);
}

function describe(f: FrameFeatures) {
  const tone = f.brightness > 175 ? "bright" : f.brightness < 55 ? "dark" : f.brightness < 90 ? "dim" : "balanced";
  const temp = f.warmth > 18 ? "warm" : f.warmth < -18 ? "cool" : "neutral";
  const sat = f.saturation > 0.45 ? "vivid" : f.saturation < 0.16 ? "muted" : "natural-colour";
  const contrast = f.contrast > 62 ? "high-contrast" : f.contrast < 30 ? "soft, low-contrast" : "moderate-contrast";
  const hx = f.focal.x < 0.38 ? "left" : f.focal.x > 0.62 ? "right" : "centre";
  const vy = f.focal.y < 0.38 ? "upper" : f.focal.y > 0.62 ? "lower" : "middle";
  const thirds = [1 / 3, 2 / 3].some((t) => Math.abs(f.focal.x - t) < 0.07) || [1 / 3, 2 / 3].some((t) => Math.abs(f.focal.y - t) < 0.07);
  return { tone, temp, sat, contrast, where: `${vy} ${hx}`.replace("middle centre", "centre"), thirds };
}

export function analysisFromFeatures(opts: {
  f: FrameFeatures;
  metrics?: VisualMetrics;
  width: number | null;
  height: number | null;
  kind: "image" | "video";
  moments?: AssetAnalysis["moments"];
}): AssetAnalysis {
  const { f, metrics } = opts;
  const d = describe(f);
  const shortEdge = Math.min(opts.width ?? 0, opts.height ?? 0);
  const issues: string[] = [...(metrics?.notes ?? [])];
  if (shortEdge > 0 && shortEdge < 720) issues.push(`Low resolution (${opts.width}×${opts.height}); will be upscaled for HD output.`);
  let quality: AssetAnalysis["visualQuality"] = "good";
  if (metrics?.blurry || metrics?.veryDark) quality = "poor";
  else if (metrics?.soft || metrics?.dark || (shortEdge > 0 && shortEdge < 720)) quality = "fair";
  else if (shortEdge >= 1080 && f.contrast > 35 && f.brightness > 70 && f.brightness < 210) quality = "excellent";
  const hs = hookScore(f, metrics);
  const roles: AssetAnalysis["storyRoles"] = [];
  if (hs >= 0.62) roles.push("hook");
  if (f.concentration < 0.3 && f.aspect > 1.1) roles.push("establishing");
  if (f.concentration >= 0.38) roles.push("detail");
  if (f.warmth > 12 && f.colorfulness > 35) roles.push("emotional_peak");
  if (f.warmth > 8 && f.contrast < 55) roles.push("closing");
  if (roles.length === 0) roles.push("b_roll");
  const crop: AssetAnalysis["verticalCropSuitability"] = f.verticalFit >= 0.7 ? "good" : f.verticalFit >= 0.45 ? "tight" : "unsuitable";
  const palette = f.colors.slice(0, 3).map((c) => c.name);
  return {
    summary: `Measured: ${d.tone}, ${d.temp}, ${d.sat}, ${d.contrast} ${opts.kind === "video" ? "clip" : "frame"}; dominant ${palette.join(", ") || "mixed"} tones; visual focus ${d.where}.`,
    mainSubject: "Not identified — local analysis measures light, colour and detail, not objects",
    setting: "Not identified",
    people: "Not assessed (no AI vision)",
    objects: [],
    composition: `Visual weight sits ${d.where}${d.thirds ? " near a rule-of-thirds line" : ""}; attention is ${f.concentration >= 0.38 ? "concentrated on one area" : f.concentration >= 0.25 ? "moderately focused" : "spread across the frame"}.`,
    lighting: `${d.tone} exposure (mean luma ${Math.round(f.brightness)}), ${d.contrast}`,
    dominantColors: palette,
    visualQuality: quality,
    qualityIssues: issues.slice(0, 8),
    storyRoles: roles.slice(0, 4),
    hookStrength: Math.max(1, Math.min(5, Math.round(1 + hs * 4))),
    focalPoint: f.focal,
    verticalCropSuitability: crop,
    uncertainObservations: ["Objects, people and places are not identified without AI vision; these notes are measurements, and the focal point is an estimate of where detail and colour concentrate."],
    moments: opts.moments ?? [],
    recommended: quality !== "poor",
    recommendationReason:
      quality === "poor"
        ? `Not recommended as a featured shot: ${issues[0] ?? "measured quality is low"}.`
        : `${quality === "excellent" ? "Excellent" : quality === "good" ? "Good" : "Usable"} measured quality; hook potential ${Math.round(1 + hs * 4)}/5${crop !== "good" && f.aspect > 1.1 ? "; best shown full-frame with a blurred fill in vertical formats" : ""}.`,
    analyzer: "local_metrics",
  };
}

/** Analyse an image or a video (sampled frames + motion) on-device. */
export async function analyseLocally(opts: {
  src: string;
  workDir: string;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  durationSec: number | null;
  metrics?: VisualMetrics;
  signal?: AbortSignal;
}): Promise<AssetAnalysis & { features: FrameFeatures }> {
  const aspect = (opts.width ?? 1) / (opts.height ?? 1);
  if (opts.kind === "image") {
    const r = await decodeRaster(opts.src, opts.workDir, { signal: opts.signal });
    const f = frameFeatures(r, aspect);
    return { ...analysisFromFeatures({ f, metrics: opts.metrics, width: opts.width, height: opts.height, kind: "image" }), features: f };
  }
  const dur = opts.durationSec ?? 1;
  const n = Math.max(3, Math.min(8, Math.round(dur / 1.5)));
  const samples: { t: number; f: FrameFeatures; r: Raster }[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur - 0.05, ((i + 0.5) * dur) / n);
    const r = await decodeRaster(opts.src, opts.workDir, { atSec: t, w: 64, h: 64, signal: opts.signal });
    samples.push({ t, f: frameFeatures(r, aspect), r });
  }
  const motion = samples.map((s, i) => {
    const prev = samples[i - 1] ?? samples[i + 1];
    if (!prev) return 0;
    let d = 0;
    for (let p = 0; p < s.r.data.length; p += 3) d += Math.abs((s.r.data[p + 1] as number) - (prev.r.data[p + 1] as number));
    return d / (s.r.data.length / 3) / 255;
  });
  const scores = samples.map((s, i) => hookScore(s.f, opts.metrics) + 0.15 * Math.min(1, (motion[i] as number) * 6));
  const order = [...scores].sort((a, b) => b - a);
  const hi = order[Math.floor(order.length / 3)] ?? 0;
  const half = dur / n / 2;
  const moments: AssetAnalysis["moments"] = [];
  samples.forEach((s, i) => {
    const q = (scores[i] as number) >= hi ? "strong" : s.f.brightness < 45 || s.f.contrast < 18 ? "weak" : "usable";
    const start = Math.max(0, Math.round((s.t - half) * 100) / 100);
    const end = Math.min(dur, Math.round((s.t + half) * 100) / 100);
    const last = moments[moments.length - 1];
    if (last && last.quality === q && Math.abs(last.endSec - start) < 0.02) last.endSec = end;
    else moments.push({ startSec: start, endSec: end, quality: q, description: `${q === "strong" ? "Most striking section" : q === "weak" ? "Flat or dark section" : "Usable section"}${(motion[i] as number) > 0.08 ? " with noticeable movement" : ""}` });
  });
  const best = samples[scores.indexOf(Math.max(...scores))] as (typeof samples)[number];
  const a = analysisFromFeatures({ f: best.f, metrics: opts.metrics, width: opts.width, height: opts.height, kind: "video", moments: moments.slice(0, 10) });
  return { ...a, features: best.f };
}
