import { QualityReportSchema, type Edl, type QcIssue, type QualityReport } from "@/lib/schemas";
import type { CreativeReview } from "../agent/steps";
import { qualityLabel, type TechnicalEvaluation } from "./checks";
import type { RenderInspection } from "./inspect";

/** Build and validate the per-render quality report. */
export function buildQualityReport(opts: {
  inspection: RenderInspection;
  evaluation: TechnicalEvaluation;
  edl: Edl;
  review: (CreativeReview & { assessedBy?: "claude_vision" | "local_heuristics" }) | null;
  reviewError: string | null;
  frames: { timeSec: number; rel: string }[];
  contactSheetRel: string | null;
}): QualityReport {
  const { inspection: ins, evaluation: ev, review, edl } = opts;
  const issues: QcIssue[] = [...ev.issues];
  if (review) for (const i of review.issues) issues.push({ ...i, source: "creative" });
  const recommendations = [...(review?.recommendations ?? [])];
  if (edl.clips.some((c) => c.upscaled)) recommendations.push("Some sources are lower resolution than the output; for crisper results use higher-resolution originals.");
  const highCreative = issues.filter((i) => i.source === "creative" && i.severity === "high" && i.certainty !== "uncertain").length;
  const warnings = [...ev.technical, ...ev.audio, ...ev.visual].filter((c) => c.status === "warn").length + issues.filter((i) => i.severity !== "low").length;
  const status: QualityReport["status"] = ev.blockingFailures > 0 || highCreative > 0 ? "failed" : warnings > 0 ? "passed_with_warnings" : "passed";
  const v = ins.info?.video ?? null;
  const report: QualityReport = {
    status,
    generatedAt: new Date().toISOString(),
    output: {
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: v?.fps ?? null,
      durationSec: ins.info?.durationSec ?? null,
      videoCodec: v?.codec ?? null,
      audioCodec: ins.info?.audio?.codec ?? null,
      sizeBytes: ins.sizeBytes || null,
      bitrateKbps: ins.bitrateKbps,
    },
    technicalChecks: ev.technical,
    audioChecks: ev.audio,
    visualChecks: ev.visual,
    creativeReview: review
      ? {
          assessedBy: review.assessedBy ?? "claude_vision",
          openingHook: review.openingHook,
          captionReadability: review.captionReadability,
          visualConsistency: review.visualConsistency,
          composition: review.composition,
          ending: review.ending,
          summary: review.summary,
        }
      : {
          assessedBy: "not_available",
          openingHook: "not_assessed",
          captionReadability: "not_assessed",
          visualConsistency: "not_assessed",
          composition: "not_assessed",
          ending: "not_assessed",
          summary: opts.reviewError ?? "Creative review was skipped because a blocking technical check failed.",
        },
    issues,
    recommendations,
    reviewFrames: opts.frames.map((f) => ({ timeSec: f.timeSec, path: f.rel })),
    contactSheet: opts.contactSheetRel,
    qualityLabel: qualityLabel(v?.width ?? null, v?.height ?? null, edl.clips.filter((c) => c.upscaled).length),
  };
  return QualityReportSchema.parse(report);
}

export function technicalSummary(ev: TechnicalEvaluation): string {
  const all = [...ev.technical, ...ev.audio, ...ev.visual];
  const notPass = all.filter((c) => c.status !== "pass");
  return notPass.length === 0 ? `All ${all.length} automated checks passed.` : notPass.map((c) => `${c.status.toUpperCase()}: ${c.label} — ${c.detail}`).join("\n");
}
