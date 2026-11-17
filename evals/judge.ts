import fs from "node:fs";
import { z } from "zod";
import type { QualityReport, Storyboard } from "../src/lib/schemas";
import { callStructured, jpegBlock } from "../src/server/agent/client";
import { storyboardDigest } from "../src/server/agent/context";
import { resolveProjectPath } from "../src/server/storage";

/**
 * Rubric judge (1–5) for subjective dimensions, scored from frames of the ACTUAL render.
 * It is one signal among several — never the only quality measure.
 */
const RubricSchema = z.object({
  story_coherence: z.number().int().min(1).max(5),
  asset_relevance: z.number().int().min(1).max(5),
  pacing: z.number().int().min(1).max(5),
  visual_consistency: z.number().int().min(1).max(5),
  typography: z.number().int().min(1).max(5),
  stylistic_fit: z.number().int().min(1).max(5),
  inventedClaims: z.boolean(),
  inventedClaimsDetail: z.string(),
  notes: z.string(),
});

export async function judgeRender(opts: { projectId: string; prompt: string; storyboard: Storyboard | null; report: QualityReport }) {
  const content: Parameters<typeof callStructured>[0]["messages"][0]["content"] = [];
  const blocks = content as unknown as object[];
  for (const f of opts.report.reviewFrames) {
    blocks.push({ type: "text", text: `Frame at ${f.timeSec}s` });
    blocks.push(jpegBlock(fs.readFileSync(resolveProjectPath(opts.projectId, f.path))));
  }
  blocks.push({
    type: "text",
    text: `User request: """${opts.prompt}"""\n\nStoryboard:\n${opts.storyboard ? storyboardDigest(opts.storyboard) : "(none)"}\n\nScore the rendered video 1-5 on each dimension (5 = professional). Flag invented product claims or facts visible in on-screen text. Be strict and specific.`,
  });
  const res = await callStructured({
    projectId: opts.projectId,
    purpose: "eval_judge",
    system: "You are a strict senior video editor scoring short social videos for an internal evaluation. Score only what is visible in the frames and stated in the plan.",
    messages: [{ role: "user", content }],
    schema: RubricSchema,
    effort: "medium",
  });
  const r = RubricSchema.parse(res.data);
  const { inventedClaims, inventedClaimsDetail, notes, ...scores } = r;
  return { scores, inventedClaims, inventedClaimsDetail, notes };
}
