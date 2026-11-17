import type { AssetAnalysis, CreativeBrief, Storyboard } from "@/lib/schemas";
import type { AudioAnalysis } from "../media/audio";
import type { VisualMetrics } from "../media/derive";

/**
 * Context construction: compact, factual descriptions of the project and its assets
 * for Claude. Only metadata and prior (validated) observations are included — never
 * file paths, and images are sent separately and deliberately.
 */
export interface AgentAsset {
  id: string;
  kind: "image" | "video" | "audio";
  originalName: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  excluded: boolean;
  metrics?: VisualMetrics;
  audio?: AudioAnalysis;
  analysis?: AssetAnalysis;
  license?: { source?: string; license?: string; attribution?: string };
}

export interface AgentProject {
  name: string;
  description: string;
  prompt: string;
  platform: string;
  aspectRatio: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  style: string;
  mood: string;
  language: string;
  captionsEnabled: boolean;
  musicPreference: string;
  silentOutput: boolean;
}

const orient = (w: number | null, h: number | null) => (!w || !h ? "unknown" : w / h > 1.05 ? "landscape" : w / h < 0.95 ? "portrait" : "square");

export function projectDigest(p: AgentProject): string {
  return [
    `Project: ${p.name}${p.description ? ` — ${p.description}` : ""}`,
    `User prompt: ${p.prompt ? `"""${p.prompt}"""` : "(none given)"}`,
    `Settings chosen in the form: platform=${p.platform}, aspect=${p.aspectRatio} (${p.width}x${p.height}), duration=${p.durationSec}s, fps=${p.fps}, style preset=${p.style}, mood=${p.mood || "(not set)"}, caption language=${p.language}, captions=${p.captionsEnabled ? "on" : "off (titles/end card only)"}, music preference=${p.musicPreference || "(not set)"}, silent output=${p.silentOutput ? "YES — no music or audio" : "no"}.`,
  ].join("\n");
}

function energySummary(a: AudioAnalysis): string {
  // 2-second resolution, 0–9 scale, to keep the context small.
  const per = 4;
  const out: number[] = [];
  for (let i = 0; i < a.energy.length; i += per) {
    const slice = a.energy.slice(i, i + per);
    out.push(Math.round((slice.reduce((s, x) => s + x, 0) / Math.max(1, slice.length)) * 9));
  }
  return out.join("");
}

export function assetDigest(assets: AgentAsset[], opts: { includeAnalysis?: boolean } = {}): string {
  const lines: string[] = [];
  for (const a of assets) {
    if (a.excluded) continue;
    const head = `- id=${a.id} | ${a.kind} | "${a.originalName}"`;
    if (a.kind === "audio") {
      const au = a.audio;
      lines.push(
        `${head} | ${a.durationSec?.toFixed(1) ?? "?"}s | ${au ? `BPM ${au.bpm ?? "not detected"} (confidence ${au.bpmConfidence}), peak ${au.peakDb} dBFS, energy per 2s (0-9): ${energySummary(au)}` : "not analysed"}${a.license?.license ? ` | licence: ${a.license.license}` : ""}`,
      );
      continue;
    }
    const parts = [head, `${a.width}x${a.height} ${orient(a.width, a.height)}`];
    if (a.kind === "video") parts.push(`${a.durationSec?.toFixed(2)}s${a.hasAudio ? ", has audio" : ", no audio"}`);
    if (a.metrics) {
      parts.push(`brightness ${a.metrics.brightness}/255, blur score ${a.metrics.blur}${a.metrics.notes.length ? ` (${a.metrics.notes.join(" ")})` : ""}`);
    }
    lines.push(parts.join(" | "));
    if (opts.includeAnalysis !== false && a.analysis) {
      const an = a.analysis;
      lines.push(
        `    analysis: ${an.summary} Subject: ${an.mainSubject}. Setting: ${an.setting}. Quality: ${an.visualQuality}${an.qualityIssues.length ? ` (${an.qualityIssues.join("; ")})` : ""}. Roles: ${an.storyRoles.join(", ") || "-"}. Hook ${an.hookStrength}/5. Focal point (${an.focalPoint.x.toFixed(2)}, ${an.focalPoint.y.toFixed(2)}). Vertical crop: ${an.verticalCropSuitability}. ${an.recommended ? "Recommended" : "Not recommended"}: ${an.recommendationReason}${an.uncertainObservations.length ? ` Uncertain: ${an.uncertainObservations.join("; ")}.` : ""}`,
      );
      if (an.moments.length) lines.push(`    moments: ${an.moments.map((m) => `${m.startSec.toFixed(1)}-${m.endSec.toFixed(1)}s ${m.quality}: ${m.description}`).join(" | ")}`);
    } else if (opts.includeAnalysis !== false) {
      lines.push("    analysis: not available (no AI vision analysis); rely on metadata only.");
    }
  }
  return lines.join("\n");
}

export function briefDigest(b: CreativeBrief): string {
  return JSON.stringify(b, null, 1);
}

/** Compact storyboard view for revision/review prompts. */
export function storyboardDigest(sb: Storyboard): string {
  let t = 0;
  const scenes = sb.scenes.map((s) => {
    const line = `${s.id} [${t.toFixed(1)}–${(t + s.durationSec).toFixed(1)}s] asset=${s.assetId} ${s.purpose}; motion=${s.motion}/${s.motionIntensity}; fit=${s.fit}; in=${s.transitionIn.type} ${s.transitionIn.durationSec}s; text=${s.text ? `"${s.text.content}" (${s.text.style}, ${s.text.position})` : "none"}`;
    t += s.durationSec;
    return line;
  });
  return [`Title: ${sb.title}. Grade ${sb.colorGrade} @${sb.gradeIntensity}; typography ${sb.typography}; music ${sb.music ? `${sb.music.assetId} from ${sb.music.startSec}s vol ${sb.music.volume} beatSync ${sb.music.beatSync}` : "none"}; end card ${sb.endCard ? `"${sb.endCard.text}"` : "none"}.`, ...scenes].join("\n");
}
