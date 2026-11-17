/**
 * Project workflow state machine. Every stage change goes through `assertTransition`,
 * so the app can never jump to "completed" without passing through rendering + QC.
 */
export const STAGES = [
  "draft", // created; media being added
  "analysing", // asset analysis running
  "analysed", // assets analysed; ready to plan
  "planning", // brief + storyboard being generated
  "needs_clarification", // agent asked the user a question
  "plan_ready", // storyboard ready for approval
  "rendering", // render + QC running
  "completed", // at least one render passed QC
  "failed", // last operation failed (previous successful renders are kept)
] as const;
export type Stage = (typeof STAGES)[number];

const ALLOWED: Record<Stage, Stage[]> = {
  draft: ["analysing", "planning", "rendering", "draft"],
  analysing: ["analysed", "failed", "draft"],
  analysed: ["analysing", "planning", "rendering", "draft"],
  planning: ["plan_ready", "needs_clarification", "rendering", "failed"],
  needs_clarification: ["planning", "analysing", "draft"],
  plan_ready: ["planning", "rendering", "analysing", "plan_ready", "draft"],
  rendering: ["completed", "failed", "plan_ready"],
  completed: ["analysing", "planning", "rendering", "plan_ready", "completed", "draft"],
  failed: ["analysing", "planning", "rendering", "draft", "plan_ready", "completed"],
};

export function canTransition(from: string, to: Stage): boolean {
  const list = ALLOWED[from as Stage];
  return Array.isArray(list) && list.includes(to);
}

export function assertTransition(from: string, to: Stage): void {
  if (!canTransition(from, to)) throw new Error(`Invalid workflow transition: ${from} → ${to}`);
}

export const STAGE_LABELS: Record<Stage, string> = {
  draft: "Draft",
  analysing: "Analysing media",
  analysed: "Media analysed",
  planning: "Planning",
  needs_clarification: "Needs your input",
  plan_ready: "Plan ready for review",
  rendering: "Rendering & checking",
  completed: "Video ready",
  failed: "Needs attention",
};
