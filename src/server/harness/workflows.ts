import type { Job, Project, Storyboard as StoryboardRow } from "@prisma/client";
import { StoryboardSchema, type QualityReport, type Storyboard } from "@/lib/schemas";
import { getConfig } from "../config";
import { db, newId, parseJson } from "../db";
import { AppError, errorMessage, isAppError } from "../errors";
import { aiConfigured } from "../agent/client";
import { heuristicStoryboard } from "../agent/heuristicPlanner";
import type { AgentProject } from "../agent/context";
import { evaluateTechnical, reviewTimestamps, sceneAt } from "../qc/checks";
import { buildQualityReport, technicalSummary } from "../qc/report";
import { normalizeDurations } from "../render/storyboardValidation";
import type { CompileContext } from "../render/types";
import { loadProjectAssets, toAgentAsset, toPlanAsset } from "../services/assets";
import { recordEvent, setStage } from "../services/events";
import { cleanWorkDir } from "../storage";
import { registerHandler, setFailureHook, type JobContext, type JobResult } from "./jobs";
import { runTool } from "./registry";
import { canTransition, type Stage } from "./stateMachine";
import { diffStoryboards } from "./revision";
import type { StyleId } from "@/lib/presets";
import {
  analyseAssetsTool,
  createCreativeBriefTool,
  createEdlTool,
  createStoryboardTool,
  creativeReviewTool,
  extractReviewFramesTool,
  inspectRenderTool,
  renderVideoTool,
  reviseEditTool,
  validateEdlTool,
  validateStoryboardTool,
} from "./tools";

/**
 * Agent orchestrator: the controlled workflows that sequence tools, Claude calls,
 * validation, rendering, quality gates and bounded self-correction.
 */

export function agentProject(p: Project): AgentProject {
  return {
    name: p.name,
    description: p.description,
    prompt: p.prompt,
    platform: p.platform,
    aspectRatio: p.aspectRatio,
    durationSec: p.durationSec,
    width: p.width,
    height: p.height,
    fps: p.fps,
    style: p.style,
    mood: p.mood,
    language: p.language,
    captionsEnabled: p.captionsEnabled,
    musicPreference: p.musicPreference,
    silentOutput: p.silentOutput,
  };
}

export async function loadContext(projectId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const assets = await loadProjectAssets(projectId);
  const ready = assets.filter((a) => a.status === "ready");
  const cfg = getConfig();
  const compile: CompileContext = {
    project: {
      platform: project.platform,
      width: project.width,
      height: project.height,
      fps: ([24, 25, 30, 60].includes(project.fps) ? project.fps : 30) as 24 | 25 | 30 | 60,
      durationSec: project.durationSec,
      silentOutput: project.silentOutput,
    },
    assets: new Map(ready.map((a) => [a.id, toPlanAsset(a)])),
    render: { crf: cfg.render.crf, preset: cfg.render.preset },
    maxOutputDurationSec: cfg.limits.maxOutputDurationSec,
  };
  return { project, assets: ready, agentAssets: ready.map(toAgentAsset), compile, agent: agentProject(project) };
}

async function nextVersion(table: "storyboard" | "edl" | "render" | "brief", projectId: string): Promise<number> {
  const agg =
    table === "storyboard"
      ? await db.storyboard.aggregate({ where: { projectId }, _max: { version: true } })
      : table === "edl"
        ? await db.edl.aggregate({ where: { projectId }, _max: { version: true } })
        : table === "render"
          ? await db.render.aggregate({ where: { projectId }, _max: { version: true } })
          : await db.brief.aggregate({ where: { projectId }, _max: { version: true } });
  return (agg._max.version ?? 0) + 1;
}

export function parseStoryboardRow(row: StoryboardRow): Storyboard {
  return StoryboardSchema.parse(parseJson(row.json));
}

async function saveStoryboard(projectId: string, sb: Storyboard, source: string, opts: { parentVersion?: number | null; note?: string; approved?: boolean } = {}) {
  const version = await nextVersion("storyboard", projectId);
  return db.storyboard.create({
    data: {
      id: newId(),
      projectId,
      version,
      parentVersion: opts.parentVersion ?? null,
      json: JSON.stringify(sb),
      source,
      note: (opts.note ?? "").slice(0, 2000),
      approved: opts.approved ?? false,
      approvedAt: opts.approved ? new Date() : null,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Analyse                                                             */
/* ------------------------------------------------------------------ */

async function analyseAssets(ctx: JobContext, opts: { force: boolean; progressSpan: [number, number] }) {
  const { projectId } = ctx;
  const { assets } = await loadContext(projectId);
  const targets = assets.filter((a) => a.kind !== "audio" && !a.excluded && (opts.force || !a.analysisJson));
  if (targets.length === 0) return { analysed: 0, failed: 0 };
  if (!aiConfigured()) {
    await recordEvent(projectId, "analysis_skipped", "AI vision analysis skipped: Claude is not configured. Metadata and measured quality are still available.", "warning");
    return { analysed: 0, failed: 0 };
  }
  let done = 0;
  let failed = 0;
  const [p0, p1] = opts.progressSpan;
  const queue = [...targets];
  const worker = async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      if (ctx.signal.aborted) throw new AppError("CANCELLED", "Operation cancelled.");
      try {
        const analysis = await runTool(analyseAssetsTool, { projectId, asset: toAgentAsset(a), rel: `originals/${a.storedName}` }, { projectId, jobId: ctx.job.id, signal: ctx.signal });
        await db.asset.update({ where: { id: a.id }, data: { analysisJson: JSON.stringify(analysis) } });
      } catch (e) {
        if (isAppError(e) && (e.code === "CANCELLED" || e.code === "LIMIT_EXCEEDED" || e.code === "AI_NOT_CONFIGURED")) throw e;
        failed++;
        await recordEvent(projectId, "analysis_failed", `Could not analyse "${a.originalName}": ${errorMessage(e)}`, "warning");
      }
      done++;
      ctx.progress(p0 + ((p1 - p0) * done) / targets.length, `Analysing media with Claude vision (${done}/${targets.length})`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (failed === targets.length) throw new AppError("AI_FAILED", "Asset analysis failed for every file.", { transient: true });
  return { analysed: done - failed, failed };
}

registerHandler("analyse", async (ctx) => {
  await setStage(ctx.projectId, "analysing", "Analysing your media");
  const r = await analyseAssets(ctx, { force: Boolean(ctx.payload.force), progressSpan: [0.02, 0.98] });
  const { assets } = await loadContext(ctx.projectId);
  const analysed = assets.map(toAgentAsset).filter((a) => a.analysis);
  const recommended = analysed.filter((a) => a.analysis?.recommended).length;
  const concerns = assets.map(toAgentAsset).filter((a) => a.metrics && (a.metrics.dark || a.metrics.blurry || a.analysis?.visualQuality === "poor"));
  await recordEvent(
    ctx.projectId,
    "analysis_done",
    r.analysed > 0
      ? `Analysed ${r.analysed} file${r.analysed === 1 ? "" : "s"}; ${recommended} recommended for the edit.${concerns.length ? ` ${concerns.length} file(s) look dark or blurry.` : ""}`
      : `Media inspected.${concerns.length ? ` ${concerns.length} file(s) look dark or blurry.` : ""}`,
    "success",
  );
  await setStage(ctx.projectId, "analysed");
  return { result: r };
});

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

registerHandler("plan", async (ctx): Promise<JobResult> => {
  const { projectId } = ctx;
  const mode = ctx.payload.mode === "basic" || !aiConfigured() ? "basic" : "ai";
  const clarification = typeof ctx.payload.clarification === "string" ? ctx.payload.clarification : null;
  const autoRender = Boolean(ctx.payload.autoRender);
  await setStage(projectId, "planning", mode === "ai" ? "Claude is planning your video" : "Assembling a basic plan");
  let { project, agentAssets, compile, agent } = await loadContext(projectId);
  const visuals = agentAssets.filter((a) => !a.excluded && a.kind !== "audio");
  if (visuals.length === 0) throw new AppError("BAD_REQUEST", "Add at least one photo or video clip (and don't exclude them all) before planning.");

  let sb: Storyboard;
  let source: string;
  let note = "";
  if (mode === "basic") {
    ctx.progress(0.3, "Assembling a basic plan (no AI)");
    sb = heuristicStoryboard({
      projectName: project.name,
      style: project.style as StyleId,
      durationSec: project.durationSec,
      width: project.width,
      height: project.height,
      captionsEnabled: project.captionsEnabled,
      silentOutput: project.silentOutput,
      assets: agentAssets,
    });
    source = "heuristic";
    note = "Basic assembly (no AI): best-measured shot first, then upload order.";
  } else {
    if (agentAssets.some((a) => !a.excluded && a.kind !== "audio" && !a.analysis)) {
      await analyseAssets(ctx, { force: false, progressSpan: [0.02, 0.35] });
      ({ project, agentAssets, compile, agent } = await loadContext(projectId));
    }
    ctx.progress(0.38, "Writing the creative brief");
    const brief = await runTool(createCreativeBriefTool, { projectId, project: agent, assets: agentAssets, clarification }, { projectId, jobId: ctx.job.id, signal: ctx.signal });
    const bv = await nextVersion("brief", projectId);
    await db.brief.create({ data: { id: newId(), projectId, version: bv, json: JSON.stringify(brief), source: "ai" } });
    await recordEvent(projectId, "brief_ready", `Creative brief v${bv}: "${brief.title}".${brief.assumptions.length ? ` Assumptions: ${brief.assumptions.slice(0, 3).join("; ")}.` : ""}`, "info", { conflicts: brief.conflicts, qualityConcerns: brief.qualityConcerns });
    if (brief.needsClarification && brief.clarificationQuestion && !clarification) {
      await setStage(projectId, "needs_clarification", brief.clarificationQuestion);
      await recordEvent(projectId, "clarification_needed", `Question for you: ${brief.clarificationQuestion}`, "warning");
      return { result: { clarification: brief.clarificationQuestion } };
    }
    ctx.progress(0.5, "Designing the storyboard");
    const out = await runTool(createStoryboardTool, { projectId, project: agent, brief, assets: agentAssets, compile }, { projectId, jobId: ctx.job.id, signal: ctx.signal });
    sb = out.storyboard;
    source = "ai";
    note = out.repairs > 0 ? `Claude corrected its plan ${out.repairs} time(s) after validation feedback.` : "";
  }

  const norm = normalizeDurations(sb, project.durationSec);
  if (norm.changed) {
    sb = norm.storyboard;
    note = `${note} Scene durations rescaled to exactly ${project.durationSec}s.`.trim();
  }
  ctx.progress(0.85, "Validating the plan");
  const sv = await runTool(validateStoryboardTool, { projectId, storyboard: sb, compile }, { projectId, jobId: ctx.job.id });
  if (!sv.valid) throw new AppError("VALIDATION_FAILED", `The plan failed validation: ${sv.errors.slice(0, 3).join(" ")}`, { details: sv.errors });
  const { edl, warnings } = await runTool(createEdlTool, { projectId, storyboard: sb, compile }, { projectId, jobId: ctx.job.id });
  const ev = await runTool(validateEdlTool, { projectId, edl, compile }, { projectId, jobId: ctx.job.id });
  if (!ev.valid) throw new AppError("VALIDATION_FAILED", `The edit could not be compiled safely: ${ev.errors.slice(0, 3).join(" ")}`, { details: ev.errors });
  const allWarnings = [...new Set([...sv.warnings, ...warnings, ...ev.warnings])];
  const row = await saveStoryboard(projectId, sb, source, { note: [note, ...allWarnings.map((w) => `• ${w}`)].filter(Boolean).join("\n"), approved: !project.requireApproval || autoRender });
  await recordEvent(projectId, "storyboard_ready", `Storyboard v${row.version} ready: ${sb.scenes.length} scenes, ${project.durationSec}s${source === "heuristic" ? " (basic assembly, no AI)" : ""}.`, "success", { warnings: allWarnings });
  await setStage(projectId, "plan_ready", project.requireApproval && !autoRender ? "Review the plan, then render" : "Plan approved automatically");
  if (!project.requireApproval || autoRender) return { result: { storyboardVersion: row.version }, next: { type: "render", payload: { storyboardVersion: row.version } } };
  return { result: { storyboardVersion: row.version } };
});

/* ------------------------------------------------------------------ */
/* Render + QC + bounded auto-fix                                      */
/* ------------------------------------------------------------------ */

async function deterministicFix(report: QualityReport, sb: Storyboard): Promise<{ sb: Storyboard; note: string } | null> {
  const clipping = report.issues.some((i) => i.source === "audio" && /clipping/i.test(i.description));
  const quiet = report.audioChecks.some((c) => c.id === "loudness" && c.status === "fail");
  if ((clipping || quiet) && sb.music) {
    const factor = clipping ? 0.7 : 1.4;
    return {
      sb: {
        ...sb,
        music: { ...sb.music, volume: Math.min(1.5, Math.max(0.1, Math.round(sb.music.volume * factor * 100) / 100)) },
        scenes: sb.scenes.map((s) => ({ ...s, clipAudioVolume: Math.min(1.5, Math.round(s.clipAudioVolume * factor * 100) / 100) })),
      },
      note: clipping ? "Lowered music and clip audio levels to remove clipping." : "Raised music level; the mix was too quiet.",
    };
  }
  return null;
}

registerHandler("render", async (ctx): Promise<JobResult> => {
  const { projectId } = ctx;
  const cfg = getConfig();
  const renderCount = await db.render.count({ where: { projectId } });
  if (renderCount >= cfg.limits.maxRendersPerProject) throw new AppError("LIMIT_EXCEEDED", `This project reached its limit of ${cfg.limits.maxRendersPerProject} renders.`);
  const wanted = typeof ctx.payload.storyboardVersion === "number" ? ctx.payload.storyboardVersion : null;
  const row = wanted
    ? await db.storyboard.findUnique({ where: { projectId_version: { projectId, version: wanted } } })
    : await db.storyboard.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!row) throw new AppError("BAD_REQUEST", "There is no plan to render yet. Create a plan first.");
  if (!row.approved) await db.storyboard.update({ where: { id: row.id }, data: { approved: true, approvedAt: new Date() } });
  await setStage(projectId, "rendering", `Rendering storyboard v${row.version}`);

  let sb = parseStoryboardRow(row);
  let sbVersion = row.version;
  let parentRenderId: string | null = null;
  const budget = cfg.limits.autoFixRenderBudget;
  let lastReport: QualityReport | null = null;
  let lastVersion = 0;
  const tctx = { projectId, jobId: ctx.job.id, signal: ctx.signal };

  for (let attempt = 0; attempt <= budget; attempt++) {
    const prefix = attempt === 0 ? "" : `Auto-fix ${attempt}: `;
    const { compile, agent, agentAssets } = await loadContext(projectId);
    const { edl, warnings } = await runTool(createEdlTool, { projectId, storyboard: sb, compile }, tctx);
    const ev = await runTool(validateEdlTool, { projectId, edl, compile }, tctx);
    const edlVersion = await nextVersion("edl", projectId);
    await db.edl.create({ data: { id: newId(), projectId, version: edlVersion, storyboardVersion: sbVersion, json: JSON.stringify(edl), validationJson: JSON.stringify(ev), valid: ev.valid } });
    if (!ev.valid) throw new AppError("VALIDATION_FAILED", `EDL v${edlVersion} failed validation: ${ev.errors.slice(0, 3).join(" ")}`, { details: ev.errors });

    const version = await nextVersion("render", projectId);
    lastVersion = version;
    const render: { id: string } = await db.render.create({
      data: { id: newId(), projectId, version, edlVersion, status: "rendering", parentRenderId, autoFixAttempt: attempt, label: attempt === 0 ? `Storyboard v${sbVersion}` : `Auto-fix ${attempt} (storyboard v${sbVersion})` },
    });
    await recordEvent(projectId, "render_started", `${prefix}Rendering v${version} (${edl.output.width}×${edl.output.height}, ${(edl.output.totalFrames / edl.output.fps).toFixed(1)}s).`, "info", { warnings });
    let outputRel: string;
    try {
      const out = await runTool(
        renderVideoTool,
        { projectId, edl, version, onProgress: (f: number, m: string) => ctx.progress(f * 0.8, `${prefix}${m}`) },
        tctx,
      );
      outputRel = out.outputRel;
      await db.render.update({ where: { id: render.id }, data: { status: "checking", outputPath: outputRel, renderMs: out.renderMs } });
    } catch (e) {
      await db.render.update({ where: { id: render.id }, data: { status: isAppError(e) && e.code === "CANCELLED" ? "cancelled" : "failed", error: errorMessage(e).slice(0, 2000), finishedAt: new Date() } });
      throw e instanceof AppError ? e : new AppError("RENDER_FAILED", `Rendering failed: ${errorMessage(e)}`);
    } finally {
      cleanWorkDir(projectId, `render_v${version}`);
    }

    ctx.progress(0.82, `${prefix}Inspecting the rendered file`);
    const inspection = await runTool(inspectRenderTool, { projectId, rel: outputRel }, tctx);
    const evaluation = evaluateTechnical(inspection, edl);
    ctx.progress(0.9, `${prefix}Extracting review frames`);
    const frames = await runTool(extractReviewFramesTool, { projectId, rel: outputRel, version, times: reviewTimestamps(edl) }, tctx);
    let review = null;
    let reviewError: string | null = null;
    if (aiConfigured() && evaluation.blockingFailures === 0) {
      ctx.progress(0.94, `${prefix}Claude is reviewing the frames`);
      try {
        review = await runTool(
          creativeReviewTool,
          {
            projectId,
            frames: frames.frames.map((f) => ({ ...f, sceneId: sceneAt(edl, f.timeSec) })),
            storyboard: sb,
            technicalSummary: technicalSummary(evaluation),
            output: { width: edl.output.width, height: edl.output.height, durationSec: edl.output.totalFrames / edl.output.fps },
          },
          tctx,
        );
      } catch (e) {
        if (isAppError(e) && e.code === "CANCELLED") throw e;
        reviewError = `Creative review unavailable: ${errorMessage(e)}`;
      }
    }
    const report = buildQualityReport({ inspection, evaluation, edl, review, reviewError, frames: frames.frames, contactSheetRel: frames.contactSheetRel });
    lastReport = report;
    const passed = report.status !== "failed";
    await db.render.update({
      where: { id: render.id },
      data: {
        status: passed ? "passed" : "failed",
        qcJson: JSON.stringify(report),
        sizeBytes: inspection.sizeBytes,
        durationSec: report.output.durationSec,
        width: report.output.width,
        height: report.output.height,
        fps: report.output.fps,
        finishedAt: new Date(),
        error: passed ? null : "Did not pass quality checks.",
      },
    });
    if (passed) {
      await recordEvent(projectId, "render_passed", `Render v${version} ${report.status === "passed" ? "passed all quality checks" : "passed with warnings"} — ${report.qualityLabel}.`, "success");
      await setStage(projectId, "completed", `Render v${version} is ready`);
      return { result: { renderVersion: version, status: report.status } };
    }
    const reasons = report.issues.filter((i) => i.severity === "high").map((i) => i.description);
    await recordEvent(projectId, "render_failed_qc", `Render v${version} did not pass QC: ${reasons.slice(0, 3).join(" ") || "blocking technical check failed"}`, "warning", { issues: report.issues });
    if (attempt === budget) break;

    // Diagnose and revise within the retry budget.
    let fixed = await deterministicFix(report, sb);
    if (!fixed && aiConfigured()) {
      const fixable = report.issues.filter((i) => i.severity === "high" && i.certainty !== "uncertain");
      if (fixable.length > 0) {
        ctx.progress(0.96, "Claude is revising the edit to fix QC issues");
        try {
          const feedback = `Automated quality control found these problems in the rendered video. Fix them with minimal changes and keep everything else the same:\n${fixable.map((i) => `- ${i.sceneId ? `scene ${i.sceneId}: ` : ""}${i.description} Suggested fix: ${i.suggestedFix}`).join("\n")}`;
          const out = await runTool(reviseEditTool, { projectId, project: agent, storyboard: sb, feedback, assets: agentAssets, compile }, tctx);
          if (out.storyboard) fixed = { sb: out.storyboard, note: `Auto-fix by Claude: ${out.plan.understanding}` };
        } catch (e) {
          if (isAppError(e) && e.code === "CANCELLED") throw e;
          await recordEvent(projectId, "auto_fix_failed", `Automatic revision failed: ${errorMessage(e)}`, "warning");
        }
      }
    }
    if (!fixed) break;
    const saved = await saveStoryboard(projectId, fixed.sb, "auto_fix", { parentVersion: sbVersion, note: fixed.note, approved: true });
    await recordEvent(projectId, "auto_fix", `${fixed.note} → storyboard v${saved.version}.`, "info");
    sb = fixed.sb;
    sbVersion = saved.version;
    parentRenderId = render.id;
  }
  const hasGood = (await db.render.count({ where: { projectId, status: "passed" } })) > 0;
  await setStage(projectId, "failed", `Render v${lastVersion} did not pass quality checks.${hasGood ? " Your previous successful render is still available." : ""}`);
  return { result: { renderVersion: lastVersion, status: lastReport?.status ?? "failed" } };
});

/* ------------------------------------------------------------------ */
/* Revise                                                              */
/* ------------------------------------------------------------------ */

registerHandler("revise", async (ctx): Promise<JobResult> => {
  const { projectId } = ctx;
  if (!aiConfigured()) throw new AppError("AI_NOT_CONFIGURED", "Natural-language revisions need Claude. Add ANTHROPIC_API_KEY to .env.");
  const feedbackId = String(ctx.payload.feedbackId ?? "");
  const fb = await db.feedback.findFirst({ where: { id: feedbackId, projectId } });
  if (!fb) throw new AppError("NOT_FOUND", "Feedback not found.");
  const row = await db.storyboard.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
  if (!row) throw new AppError("BAD_REQUEST", "There is no plan to revise yet.");
  await setStage(projectId, "planning", "Applying your feedback");
  const { compile, agent, agentAssets } = await loadContext(projectId);
  const current = parseStoryboardRow(row);
  ctx.progress(0.2, "Claude is interpreting your feedback");
  const out = await runTool(reviseEditTool, { projectId, project: agent, storyboard: current, feedback: fb.message, assets: agentAssets, compile }, { projectId, jobId: ctx.job.id, signal: ctx.signal });
  if (out.plan.needsClarification || !out.storyboard) {
    const q = out.plan.clarificationQuestion ?? "Could you clarify what you'd like to change?";
    await db.feedback.update({ where: { id: fb.id }, data: { status: "needs_clarification", summary: q, fromStoryboardVer: row.version } });
    await recordEvent(projectId, "revision_question", `About your feedback: ${q}`, "warning");
    await setStage(projectId, "plan_ready", q);
    return { result: { clarification: q } };
  }
  const diff = diffStoryboards(current, out.storyboard);
  const saved = await saveStoryboard(projectId, out.storyboard, "revision", { parentVersion: row.version, note: out.plan.understanding, approved: true });
  await db.feedback.update({ where: { id: fb.id }, data: { status: "applied", summary: out.plan.understanding, fromStoryboardVer: row.version, toStoryboardVer: saved.version } });
  await recordEvent(
    projectId,
    "revision_applied",
    `Applied feedback → storyboard v${saved.version}. Changed: ${[...diff.changed, ...diff.added].join(", ") || "global settings"}${diff.removed.length ? `; removed ${diff.removed.join(", ")}` : ""}; unchanged: ${diff.unchanged.length} scene(s).`,
    "success",
    { diff },
  );
  await setStage(projectId, "plan_ready", "Rendering your revision");
  return { result: { storyboardVersion: saved.version, diff }, next: { type: "render", payload: { storyboardVersion: saved.version } } };
});

/* ------------------------------------------------------------------ */
/* Failure handling                                                    */
/* ------------------------------------------------------------------ */

setFailureHook(async (job: Job, cancelled: boolean, error: unknown) => {
  const project = await db.project.findUnique({ where: { id: job.projectId } });
  if (!project) return;
  const hasGood = (await db.render.count({ where: { projectId: project.id, status: "passed" } })) > 0;
  const hasPlan = (await db.storyboard.count({ where: { projectId: project.id } })) > 0;
  let target: Stage;
  let message: string;
  if (cancelled) {
    target = hasGood ? "completed" : hasPlan ? "plan_ready" : job.type === "analyse" ? "draft" : "failed";
    message = "Cancelled.";
  } else {
    target = "failed";
    message = `${job.type === "render" ? "Rendering" : job.type === "plan" ? "Planning" : job.type === "revise" ? "Revision" : "Analysis"} failed: ${errorMessage(error)}${hasGood ? " Your previous successful render is still available." : ""}`;
  }
  if (!canTransition(project.stage, target)) target = "failed";
  await db.project.update({ where: { id: project.id }, data: { stage: target, stageMessage: message.slice(0, 1000) } });
  if (job.type === "revise") await db.feedback.updateMany({ where: { projectId: project.id, status: "pending" }, data: { status: cancelled ? "pending" : "failed", summary: cancelled ? "" : errorMessage(error).slice(0, 500) } });
  await recordEvent(project.id, cancelled ? "job_cancelled" : "job_failed", message, cancelled ? "warning" : "error", isAppError(error) ? { code: error.code, details: error.details } : undefined);
});

export const WORKFLOWS_REGISTERED = true;
