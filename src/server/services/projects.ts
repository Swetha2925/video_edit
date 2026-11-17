import fs from "node:fs";
import { ProjectInputSchema, ProjectUpdateSchema, QualityReportSchema, StoryboardSchema, CreativeBriefSchema, type ProjectInput } from "@/lib/schemas";
import { outputDimensions, resolutionIdFor, type AspectRatio, type ResolutionId } from "@/lib/presets";
import { db, newId, parseJson } from "../db";
import { AppError } from "../errors";
import { ensureProjectDirs, removeProjectStorage, resolveProjectPath } from "../storage";
import { assetAnalysis, assetAudio, assetMetrics, LicenseSchema } from "./assets";
import { recordEvent } from "./events";
import { activeJob, requestCancel } from "../harness/jobs";
import { STAGE_LABELS, type Stage } from "../harness/stateMachine";
import { z } from "zod";

export async function createProject(ownerId: string, raw: unknown) {
  const input: ProjectInput = ProjectInputSchema.parse(raw);
  const dims = outputDimensions(input.aspectRatio, input.resolution);
  const id = newId();
  const project = await db.project.create({
    data: {
      id,
      ownerId,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      platform: input.platform,
      aspectRatio: input.aspectRatio,
      durationSec: input.durationSec,
      width: dims.width,
      height: dims.height,
      fps: input.fps,
      style: input.style,
      mood: input.mood,
      language: input.language,
      captionsEnabled: input.captionsEnabled,
      musicPreference: input.musicPreference,
      silentOutput: input.silentOutput,
      requireApproval: input.requireApproval,
    },
  });
  ensureProjectDirs(id);
  await recordEvent(id, "project_created", `Project "${project.name}" created (${dims.width}×${dims.height}, ${input.durationSec}s).`, "success");
  return project;
}

export async function updateProject(projectId: string, raw: unknown) {
  const input = ProjectUpdateSchema.parse(raw);
  const current = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const job = await activeJob(projectId);
  if (job) throw new AppError("CONFLICT", "Settings can't be changed while a task is running.");
  const aspect = (input.aspectRatio ?? current.aspectRatio) as AspectRatio;
  const res = (input.resolution ?? resolutionIdFor(current.width, current.height)) as ResolutionId;
  const dims = outputDimensions(aspect, res);
  const { resolution: _r, ...rest } = input;
  void _r;
  return db.project.update({ where: { id: projectId }, data: { ...rest, width: dims.width, height: dims.height } });
}

export async function deleteProject(projectId: string) {
  const job = await activeJob(projectId);
  if (job) await requestCancel(projectId, job.id);
  await db.project.delete({ where: { id: projectId } });
  removeProjectStorage(projectId);
}

export async function listProjects(ownerId: string) {
  const projects = await db.project.findMany({
    where: { ownerId },
    orderBy: { updatedAt: "desc" },
    include: {
      assets: { where: { thumbnailPath: { not: null } }, orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } },
      renders: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } },
      jobs: { where: { status: { in: ["queued", "running"] } }, take: 1, select: { type: true, progress: true, message: true } },
      _count: { select: { assets: true, renders: true } },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    stage: p.stage,
    stageLabel: STAGE_LABELS[p.stage as Stage] ?? p.stage,
    style: p.style,
    platform: p.platform,
    durationSec: p.durationSec,
    width: p.width,
    height: p.height,
    updatedAt: p.updatedAt,
    assetCount: p._count.assets,
    renderCount: p._count.renders,
    coverAssetId: p.assets[0]?.id ?? null,
    latestRender: p.renders[0] ?? null,
    activeJob: p.jobs[0] ?? null,
  }));
}

/** Full workspace view for the UI. Large JSON documents are parsed + validated here. */
export async function projectDetail(projectId: string) {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const [assets, briefs, storyboards, renders, jobs, events, feedback, modelUsage] = await Promise.all([
    db.asset.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.brief.findMany({ where: { projectId }, orderBy: { version: "desc" }, take: 1 }),
    db.storyboard.findMany({ where: { projectId }, orderBy: { version: "desc" } }),
    db.render.findMany({ where: { projectId }, orderBy: { version: "desc" } }),
    db.job.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.projectEvent.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 80 }),
    db.feedback.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.modelCall.aggregate({ where: { projectId }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
  ]);
  const latestSb = storyboards[0];
  const brief = briefs[0] ? CreativeBriefSchema.safeParse(parseJson(briefs[0].json)) : null;
  return {
    project: {
      ...p,
      resolution: resolutionIdFor(p.width, p.height),
      stageLabel: STAGE_LABELS[p.stage as Stage] ?? p.stage,
    },
    assets: assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      originalName: a.originalName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      orientation: a.orientation,
      fps: a.fps,
      hasAudio: a.hasAudio,
      status: a.status,
      excluded: a.excluded,
      hasThumbnail: Boolean(a.thumbnailPath),
      metrics: assetMetrics(a) ?? null,
      audio: (() => {
        const au = assetAudio(a);
        return au ? { bpm: au.bpm, bpmConfidence: au.bpmConfidence, peakDb: au.peakDb, rmsDb: au.rmsDb, durationSec: au.durationSec } : null;
      })(),
      analysis: assetAnalysis(a) ?? null,
      license: (() => {
        const l = LicenseSchema.safeParse(parseJson(a.licenseJson));
        return l.success ? l.data : null;
      })(),
      createdAt: a.createdAt,
    })),
    brief: brief?.success ? { version: briefs[0]?.version, ...brief.data } : null,
    storyboard: latestSb
      ? (() => {
          const parsed = StoryboardSchema.safeParse(parseJson(latestSb.json));
          return parsed.success
            ? { version: latestSb.version, source: latestSb.source, note: latestSb.note, approved: latestSb.approved, parentVersion: latestSb.parentVersion, createdAt: latestSb.createdAt, data: parsed.data }
            : null;
        })()
      : null,
    storyboardVersions: storyboards.map((s) => ({ version: s.version, source: s.source, note: s.note.split("\n")[0], approved: s.approved, parentVersion: s.parentVersion, createdAt: s.createdAt })),
    renders: renders.map((r) => {
      const qc = QualityReportSchema.safeParse(parseJson(r.qcJson));
      const fileExists = r.outputPath ? fs.existsSync(resolveProjectPath(projectId, r.outputPath)) : false;
      return {
        id: r.id,
        version: r.version,
        edlVersion: r.edlVersion,
        status: r.status,
        label: r.label,
        hasFile: fileExists,
        sizeBytes: r.sizeBytes,
        durationSec: r.durationSec,
        width: r.width,
        height: r.height,
        fps: r.fps,
        renderMs: r.renderMs,
        autoFixAttempt: r.autoFixAttempt,
        error: r.error,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        qc: qc.success ? qc.data : null,
      };
    }),
    jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, progress: j.progress, message: j.message, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt })),
    events: events.map((e) => ({ id: e.id, level: e.level, kind: e.kind, message: e.message, createdAt: e.createdAt })),
    feedback: feedback.map((f) => ({ id: f.id, message: f.message, status: f.status, summary: f.summary, fromStoryboardVer: f.fromStoryboardVer, toStoryboardVer: f.toStoryboardVer, createdAt: f.createdAt })),
    usage: { modelCalls: modelUsage._count, inputTokens: modelUsage._sum.inputTokens ?? 0, outputTokens: modelUsage._sum.outputTokens ?? 0 },
  };
}

export const AssetPatchSchema = z.object({ excluded: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10_000).optional(), license: LicenseSchema.optional() });

/** User edits to on-screen text / per-scene settings before rendering (creates a new storyboard version). */
export const StoryboardEditSchema = z.object({
  baseVersion: z.number().int().positive(),
  storyboard: StoryboardSchema,
});
