import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AssetAnalysisSchema,
  CreativeBriefSchema,
  EdlSchema,
  QualityReportSchema,
  RevisionPlanSchema,
  StoryboardSchema,
  type Edl,
  type Storyboard,
} from "@/lib/schemas";
import { AudioAnalysisSchema, analyseAudioFile } from "../media/audio";
import { VisualMetricsSchema, extractKeyframes, generateThumbnail, measureVisualMetrics, prepareVisionImage } from "../media/derive";
import { MediaInfoSchema, probeMedia } from "../media/probe";
import { compileStoryboard } from "../render/compiler";
import { validateEdl } from "../render/edlValidation";
import { renderEdl } from "../render/renderer";
import { validateStoryboard } from "../render/storyboardValidation";
import { inspectRender, extractReviewFrames } from "../qc/inspect";
import { resolveProjectPath } from "../storage";
import { defineTool, ProjectRef } from "./registry";
import { analyseAsset, createBrief, createStoryboard, planRevision, reviewRender, CreativeReviewSchema } from "../agent/steps";
import { applyRevisionOps } from "./revision";
import { aiConfigured } from "../agent/client";
import { analyseLocally } from "../local/vision";
import { createLocalBrief } from "../local/brief";
import { createLocalStoryboard } from "../local/director";
import { planLocalRevision } from "../local/reviser";
import { reviewLocally } from "../local/reviewer";
import { RevisionOpSchema } from "@/lib/schemas";
import type { AgentAsset, AgentProject } from "../agent/context";
import type { CompileContext } from "../render/types";

/**
 * The approved tool set. Each tool has typed input/output, a timeout, structured logs
 * (via runTool) and operates only on files inside the current project's storage root.
 */

const AssetRef = ProjectRef.extend({ assetId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/), rel: z.string() });
const relSummary = (i: { assetId?: string; rel?: string }) => ({ input: `${i.assetId ?? ""} ${i.rel ?? ""}`.trim() });

export const inspectMediaTool = defineTool({
  name: "inspect_media",
  description: "Read container and stream metadata with FFprobe.",
  input: AssetRef,
  output: MediaInfoSchema,
  timeoutMs: 45_000,
  run: (i, ctx) => probeMedia(resolveProjectPath(ctx.projectId, i.rel), { signal: ctx.signal }),
  summarize: (i, o) => ({ ...relSummary(i), output: o ? `${o.formatName} ${o.video ? `${o.video.displayWidth}x${o.video.displayHeight}` : "no video"} ${o.durationSec ?? ""}` : undefined }),
});

export const generateThumbnailTool = defineTool({
  name: "generate_thumbnail",
  description: "Create a 480px JPEG thumbnail for an image or video.",
  input: AssetRef.extend({ kind: z.enum(["image", "video"]), durationSec: z.number().nullable() }),
  output: z.object({ thumbnailRel: z.string() }),
  timeoutMs: 60_000,
  run: async (i, ctx) => {
    const thumbnailRel = `thumbs/${i.assetId}.jpg`;
    await generateThumbnail(resolveProjectPath(ctx.projectId, i.rel), resolveProjectPath(ctx.projectId, thumbnailRel), { kind: i.kind, durationSec: i.durationSec, signal: ctx.signal });
    return { thumbnailRel };
  },
  summarize: relSummary,
});

export const measureVisualQualityTool = defineTool({
  name: "measure_visual_quality",
  description: "Deterministic exposure and sharpness metrics (signalstats + blurdetect).",
  input: AssetRef.extend({ kind: z.enum(["image", "video"]), durationSec: z.number().nullable() }),
  output: VisualMetricsSchema,
  timeoutMs: 150_000,
  run: (i, ctx) => measureVisualMetrics(resolveProjectPath(ctx.projectId, i.rel), { kind: i.kind, durationSec: i.durationSec, signal: ctx.signal }),
  summarize: (i, o) => ({ ...relSummary(i), output: o ? `brightness ${o.brightness} blur ${o.blur}` : undefined }),
});

export const analyseAudioTool = defineTool({
  name: "analyse_audio",
  description: "Loudness, tempo (BPM) and beat grid for a music track.",
  input: AssetRef,
  output: AudioAnalysisSchema,
  timeoutMs: 200_000,
  run: (i, ctx) => analyseAudioFile(resolveProjectPath(ctx.projectId, i.rel), resolveProjectPath(ctx.projectId, "work/audio"), { signal: ctx.signal }),
  summarize: (i, o) => ({ ...relSummary(i), output: o ? `bpm ${o.bpm} peak ${o.peakDb}dB` : undefined }),
});

export const extractKeyframesTool = defineTool({
  name: "extract_keyframes",
  description: "Extract evenly spaced keyframes from a video, keeping timestamps.",
  input: AssetRef.extend({ durationSec: z.number().positive(), count: z.number().int().min(1).max(12) }),
  output: z.array(z.object({ timeSec: z.number(), rel: z.string() })),
  timeoutMs: 120_000,
  run: async (i, ctx) => {
    const outDir = resolveProjectPath(ctx.projectId, "frames/keyframes");
    const frames = await extractKeyframes(resolveProjectPath(ctx.projectId, i.rel), outDir, { durationSec: i.durationSec, count: i.count, prefix: i.assetId, signal: ctx.signal });
    return frames.map((f) => ({ timeSec: f.timeSec, rel: `frames/keyframes/${path.basename(f.file)}` }));
  },
  summarize: relSummary,
});

const AgentAssetSchema = z.custom<AgentAsset>((v) => typeof v === "object" && v !== null && "id" in v);
const AgentProjectSchema = z.custom<AgentProject>((v) => typeof v === "object" && v !== null && "durationSec" in v);
const CompileCtxSchema = z.custom<CompileContext>((v) => typeof v === "object" && v !== null && "assets" in v);

export const analyseAssetsTool = defineTool({
  name: "analyse_assets",
  description: "Analyse one photo or a video (Claude vision when configured, otherwise on-device measurements).",
  input: ProjectRef.extend({ asset: AgentAssetSchema, rel: z.string() }),
  output: AssetAnalysisSchema,
  timeoutMs: 240_000,
  run: async (i, ctx) => {
    const a = i.asset;
    if (!aiConfigured()) {
      // On-device analysis: measured light, colour, detail, focal point and best moments.
      const { features: _f, ...analysis } = await analyseLocally({
        src: resolveProjectPath(ctx.projectId, i.rel),
        workDir: resolveProjectPath(ctx.projectId, "work/analysis"),
        kind: a.kind === "video" ? "video" : "image",
        width: a.width,
        height: a.height,
        durationSec: a.durationSec,
        metrics: a.metrics,
        signal: ctx.signal,
      });
      void _f;
      return analysis;
    }
    const images: { file: string; timeSec: number | null }[] = [];
    if (a.kind === "image") {
      const file = resolveProjectPath(ctx.projectId, `frames/vision/${a.id}.jpg`);
      await prepareVisionImage(resolveProjectPath(ctx.projectId, i.rel), file, { maxDim: 1024, signal: ctx.signal });
      images.push({ file, timeSec: null });
    } else if (a.kind === "video") {
      const count = Math.min(6, Math.max(3, Math.round((a.durationSec ?? 6) / 3)));
      const frames = await extractKeyframes(resolveProjectPath(ctx.projectId, i.rel), resolveProjectPath(ctx.projectId, "frames/keyframes"), {
        durationSec: a.durationSec ?? 1,
        count,
        prefix: a.id,
        signal: ctx.signal,
      });
      images.push(...frames.map((f) => ({ file: f.file, timeSec: f.timeSec })));
    }
    return analyseAsset({ projectId: ctx.projectId, asset: a, images, signal: ctx.signal });
  },
  summarize: (i, o) => ({ input: i.asset.id, output: o ? `${o.visualQuality} hook ${o.hookStrength}` : undefined }),
});

export const createCreativeBriefTool = defineTool({
  name: "create_creative_brief",
  description: "Convert the user's prompt and settings into a structured creative brief.",
  input: ProjectRef.extend({ project: AgentProjectSchema, assets: z.array(AgentAssetSchema), clarification: z.string().nullable() }),
  output: CreativeBriefSchema,
  timeoutMs: 300_000,
  run: async (i, ctx) =>
    aiConfigured()
      ? createBrief({ projectId: ctx.projectId, project: i.project, assets: i.assets, clarification: i.clarification, signal: ctx.signal })
      : createLocalBrief({ project: i.project, assets: i.assets, clarification: i.clarification }),
  summarize: (_i, o) => ({ output: o ? `${o.title}; clarification=${o.needsClarification}` : undefined }),
});

export const createStoryboardTool = defineTool({
  name: "create_storyboard",
  description: "Produce a timed scene plan from the brief and analysed media (with validation-driven repair).",
  input: ProjectRef.extend({ project: AgentProjectSchema, brief: CreativeBriefSchema, assets: z.array(AgentAssetSchema), compile: CompileCtxSchema }),
  output: z.object({ storyboard: StoryboardSchema, repairs: z.number().int() }),
  timeoutMs: 600_000,
  run: async (i, ctx) => {
    if (!aiConfigured()) {
      const storyboard = createLocalStoryboard({ project: { ...i.project, durationSec: i.brief.durationSec }, brief: i.brief, assets: i.assets });
      return { storyboard, repairs: 0 };
    }
    return createStoryboard({
      projectId: ctx.projectId,
      project: i.project,
      brief: i.brief,
      assets: i.assets,
      signal: ctx.signal,
      validate: (sb) => validateStoryboard(sb, i.compile).errors,
    });
  },
  summarize: (_i, o) => ({ output: o ? `${o.storyboard.scenes.length} scenes, ${o.repairs} repairs` : undefined }),
});

export const validateStoryboardTool = defineTool({
  name: "validate_storyboard",
  description: "Check scene structure, durations, asset references and readability.",
  input: ProjectRef.extend({ storyboard: z.unknown(), compile: CompileCtxSchema }),
  output: z.object({ valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) }),
  timeoutMs: 10_000,
  run: async (i) => {
    const r = validateStoryboard(i.storyboard, i.compile);
    return { valid: r.valid, errors: r.errors, warnings: r.warnings };
  },
  summarize: (_i, o) => ({ output: o ? `valid=${o.valid} errors=${o.errors.length} warnings=${o.warnings.length}` : undefined }),
});

export const createEdlTool = defineTool({
  name: "create_edit_decision_list",
  description: "Compile a storyboard into a frame-accurate EDL.",
  input: ProjectRef.extend({ storyboard: StoryboardSchema, compile: CompileCtxSchema }),
  output: z.object({ edl: EdlSchema, warnings: z.array(z.string()) }),
  timeoutMs: 10_000,
  run: async (i) => compileStoryboard(i.storyboard, i.compile),
  summarize: (_i, o) => ({ output: o ? `${o.edl.clips.length} clips, ${o.edl.texts.length} texts, ${o.edl.output.totalFrames} frames` : undefined }),
});

export const validateEdlTool = defineTool({
  name: "validate_edl",
  description: "Strict EDL schema + constraint validation (assets, paths, timing, effects, text safety).",
  input: ProjectRef.extend({ edl: z.unknown(), compile: CompileCtxSchema }),
  output: z.object({ valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) }),
  timeoutMs: 10_000,
  run: async (i, ctx) => {
    const r = validateEdl(i.edl, i.compile, ctx.projectId);
    return { valid: r.valid, errors: r.errors, warnings: r.warnings };
  },
  summarize: (_i, o) => ({ output: o ? `valid=${o.valid} errors=${o.errors.length}` : undefined }),
});

export const renderVideoTool = defineTool({
  name: "render_video",
  description: "Render a validated EDL with FFmpeg (segments → transitions → typography → audio mix → H.264/AAC MP4).",
  input: ProjectRef.extend({ edl: EdlSchema, version: z.number().int().positive(), onProgress: z.custom<(f: number, m: string) => void>().optional() }),
  output: z.object({ outputRel: z.string(), renderMs: z.number(), loudnessMeasured: z.boolean() }),
  timeoutMs: 60 * 60 * 1000,
  run: (i, ctx) =>
    renderEdl(ctx.projectId, i.edl as Edl, i.version, {
      signal: ctx.signal,
      workName: `render_v${i.version}`,
      onProgress: (p) => i.onProgress?.(p.fraction, p.message),
    }),
  summarize: (i, o) => ({ input: `v${i.version} ${i.edl.output.width}x${i.edl.output.height} ${i.edl.output.totalFrames}f`, output: o ? `${o.outputRel} in ${o.renderMs}ms` : undefined }),
});

const InspectionSchema = z.custom<Awaited<ReturnType<typeof inspectRender>>>((v) => typeof v === "object" && v !== null && "exists" in v);

export const inspectRenderTool = defineTool({
  name: "inspect_render",
  description: "Inspect duration, resolution, frame rate, streams, black/frozen frames, silence and levels.",
  input: ProjectRef.extend({ rel: z.string().regex(/^renders\/v\d+\.mp4$/) }),
  output: InspectionSchema,
  timeoutMs: 15 * 60 * 1000,
  run: (i, ctx) => inspectRender(resolveProjectPath(ctx.projectId, i.rel), { signal: ctx.signal }),
  summarize: (i, o) => ({ input: i.rel, output: o ? `exists=${o.exists} black=${o.black.length} frozen=${o.frozen.length} silence=${o.silence.length}` : undefined }),
});

export const extractReviewFramesTool = defineTool({
  name: "extract_review_frames",
  description: "Extract frames from the rendered output for visual review, plus a contact sheet.",
  input: ProjectRef.extend({ rel: z.string().regex(/^renders\/v\d+\.mp4$/), version: z.number().int(), times: z.array(z.number().min(0)).max(16) }),
  output: z.object({ frames: z.array(z.object({ timeSec: z.number(), rel: z.string() })), contactSheetRel: z.string().nullable() }),
  timeoutMs: 180_000,
  run: async (i, ctx) => {
    const dirRel = `frames/review_v${i.version}`;
    const out = await extractReviewFrames(resolveProjectPath(ctx.projectId, i.rel), resolveProjectPath(ctx.projectId, dirRel), i.times, { signal: ctx.signal });
    return {
      frames: out.frames.map((f) => ({ timeSec: f.timeSec, rel: `${dirRel}/${path.basename(f.file)}` })),
      contactSheetRel: out.contactSheet ? `${dirRel}/${path.basename(out.contactSheet)}` : null,
    };
  },
  summarize: (i, o) => ({ input: i.rel, output: o ? `${o.frames.length} frames` : undefined }),
});

export const creativeReviewTool = defineTool({
  name: "run_quality_checks",
  description: "Creative review of frames from the rendered file (Claude vision when configured, otherwise on-device checks).",
  input: ProjectRef.extend({
    frames: z.array(z.object({ rel: z.string(), timeSec: z.number(), sceneId: z.string().nullable() })),
    storyboard: StoryboardSchema.nullable(),
    technicalSummary: z.string(),
    output: z.object({ width: z.number(), height: z.number(), durationSec: z.number() }),
    edl: EdlSchema,
    compile: CompileCtxSchema,
    hooks: z.record(z.string(), z.number()),
  }),
  output: CreativeReviewSchema.extend({ assessedBy: z.enum(["claude_vision", "local_heuristics"]), fixes: z.array(RevisionOpSchema) }),
  timeoutMs: 300_000,
  run: async (i, ctx) => {
    const frames = i.frames.map((f) => ({ file: resolveProjectPath(ctx.projectId, f.rel), timeSec: f.timeSec, sceneId: f.sceneId }));
    if (!aiConfigured()) {
      const assets = new Map([...i.compile.assets.values()].map((a) => [a.id, { ...a, hookStrength: i.hooks[a.id], hasAnalysis: i.hooks[a.id] !== undefined }]));
      const out = await reviewLocally({ edl: i.edl, storyboard: i.storyboard, assets, frames, workDir: resolveProjectPath(ctx.projectId, "work/review"), signal: ctx.signal });
      return { ...out.review, assessedBy: "local_heuristics" as const, fixes: out.fixes };
    }
    const r = await reviewRender({ projectId: ctx.projectId, frames, storyboard: i.storyboard, technicalSummary: i.technicalSummary, output: i.output, signal: ctx.signal });
    return { ...r, assessedBy: "claude_vision" as const, fixes: [] };
  },
  summarize: (_i, o) => ({ output: o ? `hook=${o.openingHook} issues=${o.issues.length}` : undefined }),
});

export const reviseEditTool = defineTool({
  name: "revise_edit",
  description: "Translate feedback into controlled storyboard edit operations and apply them.",
  input: ProjectRef.extend({ project: AgentProjectSchema, storyboard: StoryboardSchema, feedback: z.string().min(1).max(2000), assets: z.array(AgentAssetSchema), compile: CompileCtxSchema }),
  output: z.object({ plan: RevisionPlanSchema, storyboard: StoryboardSchema.nullable(), changedSceneIds: z.array(z.string()), durationSec: z.number(), errors: z.array(z.string()) }),
  timeoutMs: 600_000,
  run: async (i, ctx) => {
    let applied: ReturnType<typeof applyRevisionOps> | null = null;
    let duration = i.project.durationSec;
    // Same validation for Claude and local plans: apply ops, then validate against the
    // (possibly new) total duration.
    const validate = (p: { needsClarification: boolean; clarificationQuestion: string | null; ops: z.infer<typeof RevisionOpSchema>[] }) => {
      if (p.needsClarification) return p.clarificationQuestion ? [] : ["needsClarification is true but clarificationQuestion is empty"];
      const setTotal = [...p.ops].reverse().find((o) => o.op === "set_total_duration");
      const target = setTotal && setTotal.op === "set_total_duration" ? setTotal.durationSec : i.project.durationSec;
      const r = applyRevisionOps(i.storyboard, p.ops, target);
      if (r.errors.length) return r.errors;
      const v = validateStoryboard(r.storyboard, { ...i.compile, project: { ...i.compile.project, durationSec: target } });
      if (!v.valid) return v.errors;
      applied = r;
      duration = target;
      return [];
    };
    let errors: string[] = [];
    const plan = aiConfigured()
      ? await planRevision({ projectId: ctx.projectId, project: i.project, storyboard: i.storyboard, feedback: i.feedback, assets: i.assets, signal: ctx.signal, validate })
      : planLocalRevision({ storyboard: i.storyboard, feedback: i.feedback, assets: i.assets, durationSec: i.project.durationSec });
    if (!aiConfigured()) errors = validate(plan);
    const a = applied as ReturnType<typeof applyRevisionOps> | null;
    return { plan, storyboard: plan.needsClarification || !a ? null : (a.storyboard as Storyboard), changedSceneIds: a?.changedSceneIds ?? [], durationSec: duration, errors };
  },
  summarize: (i, o) => ({ input: i.feedback.slice(0, 120), output: o ? `${o.plan.ops.length} ops, changed ${o.changedSceneIds.join(",")}` : undefined }),
});

export const exportVideoTool = defineTool({
  name: "export_video",
  description: "Prepare the final output file and its metadata for download.",
  input: ProjectRef.extend({ rel: z.string().regex(/^renders\/v\d+\.mp4$/), report: QualityReportSchema }),
  output: z.object({ rel: z.string(), sizeBytes: z.number(), label: z.string() }),
  timeoutMs: 30_000,
  run: async (i, ctx) => {
    const abs = resolveProjectPath(ctx.projectId, i.rel);
    const st = fs.statSync(abs);
    return { rel: i.rel, sizeBytes: st.size, label: i.report.qualityLabel };
  },
});
