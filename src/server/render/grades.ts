import type { ColorGrade } from "@/lib/presets";

/**
 * Colour grade presets → FFmpeg filter chains. All parameters are bounded and scaled by
 * `intensity` (0 = untouched, 1 = full look) so the model cannot request extreme values.
 */
interface GradeParams {
  contrast: number; // eq contrast delta (1 + d)
  saturation: number; // eq saturation delta
  brightness: number; // eq brightness delta
  gamma: number; // eq gamma delta
  shadows: [number, number, number]; // colorbalance rs gs bs
  mids: [number, number, number]; // rm gm bm
  highs: [number, number, number]; // rh gh bh
  vignette: boolean;
}

const P: Record<ColorGrade, GradeParams> = {
  natural: { contrast: 0.03, saturation: 0.05, brightness: 0, gamma: 0, shadows: [0, 0, 0], mids: [0, 0, 0], highs: [0, 0, 0], vignette: false },
  warm_natural: { contrast: 0.05, saturation: 0.08, brightness: 0.01, gamma: 0, shadows: [0.02, 0, -0.02], mids: [0.04, 0.01, -0.04], highs: [0.04, 0.01, -0.04], vignette: false },
  cinematic_teal_orange: { contrast: 0.08, saturation: 0.02, brightness: -0.01, gamma: 0, shadows: [-0.06, 0, 0.07], mids: [0.02, 0, -0.02], highs: [0.07, 0.02, -0.06], vignette: true },
  cool_crisp: { contrast: 0.07, saturation: 0, brightness: 0.01, gamma: 0, shadows: [-0.02, 0, 0.03], mids: [-0.03, 0, 0.04], highs: [0, 0, 0.02], vignette: false },
  vintage_film: { contrast: -0.05, saturation: -0.15, brightness: 0.02, gamma: 0.05, shadows: [0.03, 0.02, 0.05], mids: [0.03, 0.01, -0.02], highs: [0.05, 0.02, -0.05], vignette: true },
  moody_dark: { contrast: 0.1, saturation: -0.1, brightness: -0.03, gamma: -0.03, shadows: [-0.02, 0, 0.03], mids: [0, 0, 0], highs: [0.02, 0, -0.02], vignette: true },
  vibrant: { contrast: 0.06, saturation: 0.25, brightness: 0.01, gamma: 0, shadows: [0, 0, 0], mids: [0.01, 0, 0], highs: [0, 0, 0], vignette: false },
  bright_airy: { contrast: -0.04, saturation: -0.05, brightness: 0.04, gamma: 0.05, shadows: [0.01, 0.01, 0.02], mids: [0.01, 0, 0], highs: [0, 0, 0], vignette: false },
  black_white: { contrast: 0.1, saturation: -1, brightness: 0, gamma: 0, shadows: [0, 0, 0], mids: [0, 0, 0], highs: [0, 0, 0], vignette: true },
};

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function gradeFilter(preset: ColorGrade, intensity: number, exposureFix: number): string {
  const p = P[preset];
  const k = clamp(intensity, 0, 1);
  const parts: string[] = [];
  const contrast = clamp(1 + p.contrast * k, 0.7, 1.4);
  const saturation = clamp(1 + p.saturation * (preset === "black_white" ? 1 : k), 0, 1.6);
  const brightness = clamp(p.brightness * k + exposureFix, -0.2, 0.2);
  const gamma = clamp(1 + p.gamma * k + (exposureFix > 0 ? exposureFix * 1.2 : 0), 0.7, 1.4);
  parts.push(`eq=contrast=${f(contrast)}:saturation=${f(saturation)}:brightness=${f(brightness)}:gamma=${f(gamma)}`);
  const cb = [...p.shadows, ...p.mids, ...p.highs].map((v) => clamp(v * k, -0.3, 0.3));
  if (cb.some((v) => Math.abs(v) > 0.0005)) {
    const [rs, gs, bs, rm, gm, bm, rh, gh, bh] = cb.map(f);
    parts.push(`colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:rm=${rm}:gm=${gm}:bm=${bm}:rh=${rh}:gh=${gh}:bh=${bh}`);
  }
  if (p.vignette && k > 0.3) parts.push(`vignette=angle=${f(0.35 + 0.15 * k)}`);
  return parts.join(",");
}

/** Exposure correction suggestion from deterministic brightness (mean luma 0–255). */
export function exposureFixFor(brightness: number | undefined): number {
  if (brightness === undefined || !Number.isFinite(brightness)) return 0;
  if (brightness < 35) return 0.1;
  if (brightness < 55) return 0.06;
  if (brightness < 75) return 0.03;
  if (brightness > 215) return -0.05;
  if (brightness > 195) return -0.03;
  return 0;
}
