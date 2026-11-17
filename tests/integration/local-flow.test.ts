import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The full agent workflow with NO Claude and NO mocks: on-device analysis, brief,
 * storyboard, real FFmpeg render, local creative review, natural-language revisions.
 */
const { db, newId } = await import("@/server/db");
const { ingestUpload } = await import("@/server/services/assets");
const { createProject } = await import("@/server/services/projects");
const { enqueueJob, drainQueue } = await import("@/server/harness/jobs");
const { parseStoryboardRow } = await import("@/server/harness/workflows");
const { diffStoryboards } = await import("@/server/harness/revision");
const { makeSynthetic } = await import("@/server/dev/synthetic");
const { aiConfigured } = await import("@/server/agent/client");
const { AssetAnalysisSchema, QualityReportSchema, CreativeBriefSchema } = await import("@/lib/schemas");

const media = path.resolve(".test-storage/local-fixtures");
let userId: string;
const up = (pid: string, f: string) => ingestUpload({ projectId: pid, fileName: path.basename(f), body: Readable.toWeb(fs.createReadStream(f)) as unknown as ReadableStream<Uint8Array> });

beforeAll(async () => {
  expect(aiConfigured()).toBe(false);
  userId = (await db.user.create({ data: { id: newId() } })).id;
  await makeSynthetic("photo_landscape", media, "beach.jpg", 1);
  await makeSynthetic("photo_portrait", media, "temple.png", 2);
  await makeSynthetic("photo_square", media, "market.jpg", 3);
  await makeSynthetic("photo_dark", media, "night.jpg", 4);
  await makeSynthetic("clip_portrait", media, "walk.mp4", 5);
  await makeSynthetic("music_120bpm", media, "track.mp3");
});

describe("offline creative agent (local engine)", () => {
  it("plans from the prompt, renders, reviews and applies scoped revisions", async () => {
    const p = await createProject(userId, {
      name: "Kerala escape",
      prompt: 'A 12-second cinematic travel reel with warm natural colour, elegant text and not overly flashy. Add "Slow days by the water". End with the text "See you in Kerala".',
      durationSec: 12,
      resolution: "720p",
      requireApproval: true,
    });
    for (const f of ["beach.jpg", "temple.png", "market.jpg", "night.jpg", "walk.mp4", "track.mp3"]) await up(p.id, path.join(media, f));

    await enqueueJob(p.id, "plan", { mode: "ai" });
    await drainQueue();
    let proj = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.stage).toBe("plan_ready");
    const assets = await db.asset.findMany({ where: { projectId: p.id, kind: { not: "audio" } } });
    for (const a of assets) expect(AssetAnalysisSchema.parse(JSON.parse(a.analysisJson ?? "null")).analyzer).toBe("local_metrics");
    const brief = CreativeBriefSchema.parse(JSON.parse((await db.brief.findFirstOrThrow({ where: { projectId: p.id } })).json));
    expect(brief.colorGrade).toBe("warm_natural");
    expect(brief.qualityConcerns.join(" ")).toMatch(/dark/);
    const sbRow = await db.storyboard.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: "desc" } });
    expect(sbRow.source).toBe("local");
    const sb = parseStoryboardRow(sbRow);
    expect(sb.endCard?.text).toBe("See you in Kerala");
    expect(sb.scenes.some((s) => s.text?.content === "Slow days by the water")).toBe(true);
    expect(sb.music).not.toBeNull();
    // The very dark photo is not chosen as the hook.
    const night = assets.find((a) => a.originalName === "night.jpg");
    expect(sb.scenes[0]?.assetId).not.toBe(night?.id);

    await enqueueJob(p.id, "render", { storyboardVersion: sbRow.version });
    await drainQueue();
    const r1 = await db.render.findFirstOrThrow({ where: { projectId: p.id, status: "passed" }, orderBy: { version: "desc" } });
    const qc = QualityReportSchema.parse(JSON.parse(r1.qcJson ?? "{}"));
    expect(qc.creativeReview.assessedBy).toBe("local_heuristics");
    expect(r1.width).toBe(720);
    expect(r1.durationSec).toBeCloseTo(12, 0);

    // Revision 1 — Test E: only the opening changes.
    const before = parseStoryboardRow(await db.storyboard.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: "desc" } }));
    const fb = await db.feedback.create({ data: { id: newId(), projectId: p.id, message: "Make the first 3 seconds more engaging and keep everything else the same." } });
    await enqueueJob(p.id, "revise", { feedbackId: fb.id });
    await drainQueue();
    expect((await db.feedback.findUniqueOrThrow({ where: { id: fb.id } })).status).toBe("applied");
    const after = parseStoryboardRow(await db.storyboard.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: "desc" } }));
    const d = diffStoryboards(before, after);
    let t = 0;
    const opening = new Set(before.scenes.filter((s) => { const st = t; t += s.durationSec; return st < 3; }).map((s) => s.id));
    expect(d.changed.some((id) => opening.has(id))).toBe(true);
    expect(d.changed.filter((id) => !opening.has(id)).length).toBeLessThanOrEqual(1);
    expect((await db.render.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: "desc" } })).status).toBe("passed");

    // Revision 2: new total length updates the project and the render.
    const fb2 = await db.feedback.create({ data: { id: newId(), projectId: p.id, message: "Make it 8 seconds." } });
    await enqueueJob(p.id, "revise", { feedbackId: fb2.id });
    await drainQueue();
    proj = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.durationSec).toBe(8);
    const r3 = await db.render.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: "desc" } });
    expect(r3.status).toBe("passed");
    expect(r3.durationSec).toBeCloseTo(8, 0);

    // Unmappable feedback → a helpful question, nothing changes.
    const fb3 = await db.feedback.create({ data: { id: newId(), projectId: p.id, message: "Make it feel more like a Tuesday." } });
    const versions = await db.storyboard.count({ where: { projectId: p.id } });
    await enqueueJob(p.id, "revise", { feedbackId: fb3.id });
    await drainQueue();
    expect((await db.feedback.findUniqueOrThrow({ where: { id: fb3.id } })).status).toBe("needs_clarification");
    expect(await db.storyboard.count({ where: { projectId: p.id } })).toBe(versions);
  });

  it("asks about conflicting durations (Test D) and uses the answer", async () => {
    const p = await createProject(userId, { name: "Conflict", prompt: "Make a 60-second video of these photos.", durationSec: 20, resolution: "720p" });
    await up(p.id, path.join(media, "beach.jpg"));
    await up(p.id, path.join(media, "market.jpg"));
    await enqueueJob(p.id, "plan", { mode: "ai" });
    await drainQueue();
    let proj = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.stage).toBe("needs_clarification");
    expect(proj.stageMessage).toMatch(/60-second/);
    await enqueueJob(p.id, "plan", { mode: "ai", clarification: "Keep the 20 seconds setting" });
    await drainQueue();
    proj = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.stage).toBe("plan_ready");
    expect(proj.durationSec).toBe(20);
  });
});
