import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AssetAnalysisSchema,
  CreativeBriefSchema,
  QcIssueSchema,
  ReviewRating,
  RevisionPlanSchema,
  StoryboardSchema,
  type AssetAnalysis,
  type CreativeBrief,
  type RevisionPlan,
  type Storyboard,
} from "@/lib/schemas";
import { AppError } from "../errors";
import { callStructured, jpegBlock } from "./client";
import { assetDigest, briefDigest, projectDigest, storyboardDigest, type AgentAsset, type AgentProject } from "./context";
import { ASSET_ANALYSIS_SYSTEM, BRIEF_SYSTEM, REVIEW_SYSTEM, REVISION_SYSTEM, STORYBOARD_SYSTEM } from "./prompts";

/**
 * Claude-backed creative steps. Each returns strictly validated data or throws.
 * Where the model output fails domain validation, the step runs a bounded repair loop:
 * the validation errors are sent back and the model corrects its own output.
 */

function issuesText(e: z.ZodError): string {
  return e.issues
    .slice(0, 15)
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

async function structuredWithRepair<T>(opts: {
  projectId: string;
  purpose: string;
  system: string;
  userContent: Anthropic.Beta.BetaContentBlockParam[];
  schema: z.ZodType<T>;
  /** Extra semantic validation beyond the schema; return error strings. */
  validate?: (value: T) => string[];
  maxRepairs?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
  onRepair?: (attempt: number, errors: string[]) => void;
}): Promise<{ value: T; repairs: number }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.userContent }];
  const maxRepairs = opts.maxRepairs ?? 2;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const res = await callStructured({
      projectId: opts.projectId,
      purpose: attempt === 0 ? opts.purpose : `${opts.purpose}_repair`,
      system: opts.system,
      messages,
      schema: opts.schema,
      effort: opts.effort,
      signal: opts.signal,
    });
    const parsed = opts.schema.safeParse(res.data);
    let errors: string[] = [];
    if (!parsed.success) errors = [issuesText(parsed.error)];
    else if (opts.validate) errors = opts.validate(parsed.data);
    if (parsed.success && errors.length === 0) return { value: parsed.data, repairs: attempt };
    if (attempt === maxRepairs) {
      throw new AppError("AI_FAILED", `Claude's ${opts.purpose.replace(/_/g, " ")} did not pass validation after ${maxRepairs} repair attempts.`, { details: { errors } });
    }
    opts.onRepair?.(attempt + 1, errors);
    messages.push({ role: "assistant", content: res.assistantContent });
    messages.push({
      role: "user",
      content: `Your output failed validation:\n${errors.join("\n")}\n\nReturn the complete corrected JSON. Keep everything that was valid unchanged.`,
    });
  }
  throw new AppError("AI_FAILED", "Unreachable repair state.");
}

/* ---------------- Asset analysis (vision) ---------------- */

export async function analyseAsset(opts: {
  projectId: string;
  asset: AgentAsset;
  images: { file: string; timeSec: number | null }[];
  signal?: AbortSignal;
}): Promise<AssetAnalysis> {
  const { asset } = opts;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of opts.images) {
    if (img.timeSec !== null) content.push({ type: "text", text: `Keyframe at ${img.timeSec.toFixed(2)}s:` });
    content.push(jpegBlock(fs.readFileSync(img.file)));
  }
  const m = asset.metrics;
  content.push({
    type: "text",
    text: [
      `Asset: ${asset.kind} "${asset.originalName}", ${asset.width}x${asset.height}${asset.kind === "video" ? `, ${asset.durationSec?.toFixed(2)}s, ${asset.hasAudio ? "has audio" : "no audio"}` : ""}.`,
      m ? `Deterministic metrics: mean brightness ${m.brightness}/255 (dark < 55), blur score ${m.blur} (~5 sharp, >9 soft, >12 blurry).` : "",
      asset.kind === "video" ? "These are evenly spaced keyframes from the clip; fill 'moments' with time ranges using those timestamps." : "This is a single photo; return an empty moments array.",
      "Analyse it for use in a short social video.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const { value } = await structuredWithRepair({
    projectId: opts.projectId,
    purpose: "asset_analysis",
    system: ASSET_ANALYSIS_SYSTEM,
    userContent: content,
    schema: AssetAnalysisSchema,
    effort: "medium",
    maxRepairs: 1,
    signal: opts.signal,
    validate: (v) => {
      const d = asset.durationSec ?? 0;
      return asset.kind === "video" ? v.moments.filter((mo) => mo.endSec > d + 0.1 || mo.startSec >= mo.endSec).map((mo) => `moment ${mo.startSec}-${mo.endSec}s is outside the clip (0-${d.toFixed(2)}s) or empty`) : [];
    },
  });
  return value;
}

/* ---------------- Creative brief ---------------- */

export async function createBrief(opts: { projectId: string; project: AgentProject; assets: AgentAsset[]; clarification?: string | null; signal?: AbortSignal }): Promise<CreativeBrief> {
  const text = [
    projectDigest(opts.project),
    "",
    "Uploaded media:",
    assetDigest(opts.assets) || "(no usable media)",
    opts.clarification ? `\nThe user answered your earlier clarification question: """${opts.clarification}""". Use it; do not ask again unless something essential is still missing.` : "",
    "\nWrite the creative brief.",
  ].join("\n");
  const { value } = await structuredWithRepair({
    projectId: opts.projectId,
    purpose: "creative_brief",
    system: BRIEF_SYSTEM,
    userContent: [{ type: "text", text }],
    schema: CreativeBriefSchema,
    signal: opts.signal,
    validate: (b) => (b.needsClarification && !b.clarificationQuestion ? ["needsClarification is true but clarificationQuestion is empty"] : []),
  });
  return value;
}

/* ---------------- Storyboard ---------------- */

export async function createStoryboard(opts: {
  projectId: string;
  project: AgentProject;
  brief: CreativeBrief;
  assets: AgentAsset[];
  validate: (sb: Storyboard) => string[];
  signal?: AbortSignal;
  onRepair?: (attempt: number, errors: string[]) => void;
}): Promise<{ storyboard: Storyboard; repairs: number }> {
  const music = opts.assets.filter((a) => a.kind === "audio" && !a.excluded);
  const text = [
    projectDigest(opts.project),
    "",
    "Creative brief:",
    briefDigest(opts.brief),
    "",
    "Available media (use only these ids):",
    assetDigest(opts.assets),
    "",
    music.length && !opts.project.silentOutput ? `Music available: ${music.map((m) => m.id).join(", ")}.` : opts.project.silentOutput ? "Silent output requested: music must be null and clip audio off." : "No music uploaded: set music to null.",
    `Total duration must be ${opts.project.durationSec}s. Output frame: ${opts.project.width}x${opts.project.height}.`,
    "Create the storyboard.",
  ].join("\n");
  const { value, repairs } = await structuredWithRepair({
    projectId: opts.projectId,
    purpose: "storyboard",
    system: STORYBOARD_SYSTEM,
    userContent: [{ type: "text", text }],
    schema: StoryboardSchema,
    validate: opts.validate,
    maxRepairs: 2,
    signal: opts.signal,
    onRepair: opts.onRepair,
  });
  return { storyboard: value, repairs };
}

/* ---------------- Revision ---------------- */

export async function planRevision(opts: {
  projectId: string;
  project: AgentProject;
  storyboard: Storyboard;
  feedback: string;
  assets: AgentAsset[];
  validate: (plan: RevisionPlan) => string[];
  signal?: AbortSignal;
}): Promise<RevisionPlan> {
  const text = [
    projectDigest(opts.project),
    "",
    "Current storyboard (ids and timing):",
    storyboardDigest(opts.storyboard),
    "",
    "Full current storyboard JSON:",
    JSON.stringify(opts.storyboard),
    "",
    "Available media:",
    assetDigest(opts.assets),
    "",
    `Feedback to apply: """${opts.feedback}"""`,
    `Requested total duration: ${opts.project.durationSec}s.`,
  ].join("\n");
  const { value } = await structuredWithRepair({
    projectId: opts.projectId,
    purpose: "revision",
    system: REVISION_SYSTEM,
    userContent: [{ type: "text", text }],
    schema: RevisionPlanSchema,
    validate: opts.validate,
    maxRepairs: 2,
    signal: opts.signal,
  });
  return value;
}

/* ---------------- Creative review of the rendered file ---------------- */

export const CreativeReviewSchema = z.object({
  openingHook: ReviewRating,
  captionReadability: ReviewRating,
  visualConsistency: ReviewRating,
  composition: ReviewRating,
  ending: ReviewRating,
  summary: z.string().max(800),
  issues: z.array(QcIssueSchema.omit({ source: true })).max(12),
  recommendations: z.array(z.string().max(300)).max(8),
});
export type CreativeReview = z.infer<typeof CreativeReviewSchema>;

export async function reviewRender(opts: {
  projectId: string;
  frames: { file: string; timeSec: number; sceneId: string | null }[];
  storyboard: Storyboard | null;
  technicalSummary: string;
  output: { width: number; height: number; durationSec: number };
  signal?: AbortSignal;
}): Promise<CreativeReview> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of opts.frames) {
    content.push({ type: "text", text: `Frame at ${f.timeSec.toFixed(2)}s${f.sceneId ? ` (scene ${f.sceneId})` : ""}:` });
    content.push(jpegBlock(fs.readFileSync(f.file)));
  }
  content.push({
    type: "text",
    text: [
      `Rendered output: ${opts.output.width}x${opts.output.height}, ${opts.output.durationSec.toFixed(2)}s.`,
      opts.storyboard ? `Storyboard intent:\n${storyboardDigest(opts.storyboard)}` : "No storyboard (basic assembly).",
      `Automated technical findings:\n${opts.technicalSummary}`,
      "Review the rendered frames.",
    ].join("\n\n"),
  });
  const { value } = await structuredWithRepair({
    projectId: opts.projectId,
    purpose: "creative_review",
    system: REVIEW_SYSTEM,
    userContent: content,
    schema: CreativeReviewSchema,
    effort: "medium",
    maxRepairs: 1,
    signal: opts.signal,
  });
  return value;
}
