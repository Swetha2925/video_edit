import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AssetAnalysis, CreativeBrief, RevisionPlan, Storyboard } from "@/lib/schemas";

/**
 * Harness integration tests: real database, real uploads, real FFmpeg renders and QC.
 * Claude is replaced by a scripted fake so agent paths (repair loop, clarification,
 * auto-fix, revision accuracy) are tested deterministically and without API cost.
 */
const calls: { purpose: string; text: string }[] = [];
const script: { reviewIssues: boolean; briefClarify: boolean; badFirstStoryboard: boolean } = { reviewIssues: false, briefClarify: false, badFirstStoryboard: true };

function idsFrom(text: string, kind: string): string[] {
  return [...text.matchAll(new RegExp(`id=([a-f0-9-]{36}) \\| ${kind}`, "g"))].map((m) => m[1] as string);
}

vi.mock("@/server/agent/client", async (orig) => {
  const real = await orig<typeof import("@/server/agent/client")>();
  return {
    ...real,
    aiConfigured: () => true,
    callStructured: vi.fn(async (req: { purpose: string; messages: { content: unknown }[] }) => {
      const text = JSON.stringify(req.messages);
      calls.push({ purpose: req.purpose, text });
      let data: unknown;
      if (req.purpose.startsWith("asset_analysis")) {
        const a: AssetAnalysis = {
          summary: "A colourful abstract scene.",
          mainSubject: "abstract pattern",
          setting: "uncertain",
          people: "none visible",
          objects: [],
          composition: "centred",
          lighting: "bright",
          dominantColors: ["pink", "green"],
          visualQuality: "good",
          qualityIssues: [],
          storyRoles: ["hook"],
          hookStrength: 4,
          focalPoint: { x: 0.5, y: 0.45 },
          verticalCropSuitability: "good",
          uncertainObservations: ["Location cannot be determined."],
          moments: text.includes("Keyframe at") ? [{ startSec: 0.5, endSec: 3, description: "pattern", quality: "strong" }] : [],
          recommended: true,
          recommendationReason: "Strong colours.",
        };
        data = a;
      } else if (req.purpose.startsWith("creative_brief")) {
        const clarified = text.includes("answered your earlier clarification");
        const b: CreativeBrief = {
          title: "Test journey",
          subject: "travel",
          story: "A short journey.",
          audience: "friends",
          platform: "instagram_reels",
          durationSec: 8,
          aspectRatio: "9:16",
          mood: ["warm"],
          visualStyle: "cinematic",
          pacing: "medium",
          musicPreference: "",
          captionLanguage: "English",
          requiredText: [],
          avoid: [],
          ending: "fade out",
          hookIdea: "strongest image first",
          colorGrade: "warm_natural",
          typography: "elegant_serif",
          assumptions: ["Used project duration of 8 s."],
          conflicts: script.briefClarify && !clarified ? [{ topic: "duration", description: "Prompt says 60 s, settings say 8 s.", proposedResolution: "Ask the user." }] : [],
          needsClarification: script.briefClarify && !clarified,
          clarificationQuestion: script.briefClarify && !clarified ? "Should the video be 8 seconds (settings) or 60 seconds (prompt)?" : null,
          qualityConcerns: [],
        };
        data = b;
      } else if (req.purpose.startsWith("storyboard")) {
        const images = idsFrom(text, "image");
        const videos = idsFrom(text, "video");
        const music = idsFrom(text, "audio");
        const isRepair = req.purpose.endsWith("_repair");
        const base = { fit: "cover", focus: null, motionIntensity: "subtle", useClipAudio: false, clipAudioVolume: 0, visualDescription: "shot", musicCue: "", reason: "test" };
        const sb: Storyboard = {
          title: "Test journey",
          logline: "",
          colorGrade: "warm_natural",
          gradeIntensity: 0.7,
          typography: "elegant_serif",
          music: music[0] ? { assetId: music[0], startSec: 0, volume: 0.9, beatSync: true } : null,
          endCard: { text: "The end", subtext: null },
          fadeOutEnding: true,
          scenes: [
            { ...base, id: "s1", purpose: "Hook", durationSec: 3, assetId: images[0] as string, sourceInSec: 0, motion: "push_in", transitionIn: { type: "fade", durationSec: 0.5 }, text: { content: "Begin", style: "title", position: "center", animation: "rise" } } as Storyboard["scenes"][0],
            { ...base, id: "s2", purpose: "Middle", durationSec: 2.5, assetId: (videos[0] ?? images[1]) as string, sourceInSec: 1, motion: "none", transitionIn: { type: "dissolve", durationSec: 0.5 }, text: null } as Storyboard["scenes"][0],
            { ...base, id: "s3", purpose: "End", durationSec: 2.5, assetId: (images[1] ?? images[0]) as string, sourceInSec: 0, motion: "pan_left", transitionIn: { type: "fade", durationSec: 0.5 }, text: { content: "Home", style: "caption", position: "lower_third", animation: "fade" } } as Storyboard["scenes"][0],
          ],
        };
        if (script.badFirstStoryboard && !isRepair) {
          // Invalid on purpose: unknown asset and wrong total duration → must be repaired.
          sb.scenes[0] = { ...(sb.scenes[0] as Storyboard["scenes"][0]), assetId: "00000000-0000-0000-0000-000000000000", durationSec: 9 };
        }
        data = sb;
      } else if (req.purpose.startsWith("creative_review")) {
        const issue = script.reviewIssues
          ? [{ severity: "high", description: "Opening text covers the subject.", timeSec: 1, sceneId: "s1", suggestedFix: "Move s1 text to lower_third.", certainty: "likely" }]
          : [];
        script.reviewIssues = false; // only the first review finds the problem
        data = { openingHook: "good", captionReadability: issue.length ? "poor" : "good", visualConsistency: "good", composition: "good", ending: "good", summary: "Looks clean.", issues: issue, recommendations: [] };
      } else if (req.purpose.startsWith("revision")) {
        const plan: RevisionPlan = {
          understanding: text.includes("quality control") ? "Move the opening text lower." : "Make the opening punchier with stronger motion.",
          ops: [{ op: "update_scene", sceneId: "s1", changes: text.includes("quality control") ? { text: { content: "Begin", style: "title", position: "lower_third", animation: "rise" } } : { motion: "pull_out", motionIntensity: "strong", transitionIn: { type: "fade_black", durationSec: 0.4 } } }],
          untouchedSceneIds: ["s2", "s3"],
          needsClarification: false,
          clarificationQuestion: null,
        };
        data = plan;
      } else throw new Error(`unexpected purpose ${req.purpose}`);
      return { data, raw: JSON.stringify(data), assistantContent: [{ type: "text", text: JSON.stringify(data) }], usage: { inputTokens: 10, outputTokens: 10 } };
    }),
  };
});

const { db, newId } = await import("@/server/db");
const { ingestUpload } = await import("@/server/services/assets");
const { createProject } = await import("@/server/services/projects");
const { enqueueJob, drainQueue } = await import("@/server/harness/jobs");
await import("@/server/harness/workflows");
const { runTool } = await import("@/server/harness/registry");
const { inspectMediaTool } = await import("@/server/harness/tools");
const { makeSynthetic } = await import("@/server/dev/synthetic");
const { parseStoryboardRow } = await import("@/server/harness/workflows");
const { diffStoryboards } = await import("@/server/harness/revision");

const media = path.resolve(".test-storage/fixtures");
let userId: string;

async function upload(projectId: string, file: string, name = path.basename(file)) {
  return ingestUpload({ projectId, fileName: name, body: Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array> });
}

async function newProject(extra: Record<string, unknown> = {}) {
  const p = await createProject(userId, { name: "Harness test", durationSec: 8, resolution: "720p", ...extra });
  return p.id;
}

beforeAll(async () => {
  userId = (await db.user.create({ data: { id: newId() } })).id;
  await makeSynthetic("photo_landscape", media, "a.jpg", 1);
  await makeSynthetic("photo_portrait", media, "b.png", 2);
  await makeSynthetic("clip_landscape", media, "c.mp4", 3);
  await makeSynthetic("music_120bpm", media, "m.mp3");
  await makeSynthetic("fake_jpg", media, "fake.jpg");
  await makeSynthetic("corrupt_mp4", media, "bad.mp4");
  await makeSynthetic("photo_dark", media, "dark.jpg", 4);
  await makeSynthetic("photo_blurry", media, "blurry.jpg", 5);
});

describe("uploads (Test F: invalid files)", () => {
  it("ingests valid media with metadata, thumbnails and metrics", async () => {
    const pid = await newProject();
    const img = await upload(pid, path.join(media, "a.jpg"));
    expect(img.kind).toBe("image");
    expect(img.width).toBe(1600);
    expect(img.thumbnailPath).toBe(`thumbs/${img.id}.jpg`);
    const vid = await upload(pid, path.join(media, "c.mp4"));
    expect(vid.kind).toBe("video");
    expect(vid.durationSec).toBeCloseTo(6, 0);
    expect(vid.hasAudio).toBe(true);
    const mus = await upload(pid, path.join(media, "m.mp3"));
    expect(mus.kind).toBe("audio");
    expect(JSON.parse(mus.metricsJson ?? "{}").bpm).toBeGreaterThan(110);
  });
  it("rejects disguised and corrupt files without creating assets or leftovers", async () => {
    const pid = await newProject();
    await expect(upload(pid, path.join(media, "fake.jpg"))).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    await expect(upload(pid, path.join(media, "bad.mp4"))).rejects.toMatchObject({ code: "CORRUPT_MEDIA" });
    await expect(upload(pid, path.join(media, "a.jpg"), "a.exe")).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    expect(await db.asset.count({ where: { projectId: pid } })).toBe(0);
    const orig = path.resolve(".test-storage/projects", pid, "originals");
    expect(fs.readdirSync(orig)).toEqual([]);
    expect(fs.readdirSync(path.resolve(".test-storage/projects", pid, "work")).filter((f) => f.startsWith("upload_"))).toEqual([]);
  });
  it("flags dark and blurry media deterministically (Test C)", async () => {
    const pid = await newProject();
    const dark = await upload(pid, path.join(media, "dark.jpg"));
    const blurry = await upload(pid, path.join(media, "blurry.jpg"));
    expect(JSON.parse(dark.metricsJson ?? "{}").dark).toBe(true);
    expect(JSON.parse(blurry.metricsJson ?? "{}").soft).toBe(true);
  });
});

describe("tool permissions", () => {
  it("refuses tool calls targeting another project", async () => {
    const a = await newProject();
    const b = await newProject();
    await expect(runTool(inspectMediaTool, { projectId: b, assetId: "abcdefgh-1234", rel: "originals/x.jpg" }, { projectId: a })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const log = await db.toolCall.findFirst({ where: { projectId: a, tool: "inspect_media" }, orderBy: { createdAt: "desc" } });
    expect(log?.status).toBe("error");
  });
});

describe("workflows", () => {
  it("basic assembly → render → QC passes, with a real file and report", async () => {
    const pid = await newProject();
    await upload(pid, path.join(media, "a.jpg"));
    await upload(pid, path.join(media, "b.png"));
    await enqueueJob(pid, "plan", { mode: "basic", autoRender: true });
    await drainQueue();
    const r = await db.render.findFirst({ where: { projectId: pid } });
    expect(r?.status).toBe("passed");
    expect(r?.width).toBe(720);
    expect(r?.height).toBe(1280);
    const report = JSON.parse(r?.qcJson ?? "{}");
    expect(report.creativeReview.assessedBy).toBe("claude_vision");
    expect((await db.project.findUnique({ where: { id: pid } }))?.stage).toBe("completed");
  });

  it("AI plan: repairs an invalid storyboard, renders, auto-fixes a QC finding, then applies a scoped revision (Test E)", async () => {
    script.badFirstStoryboard = true;
    script.reviewIssues = true;
    const pid = await newProject({ requireApproval: false });
    await upload(pid, path.join(media, "a.jpg"));
    await upload(pid, path.join(media, "b.png"));
    await upload(pid, path.join(media, "c.mp4"));
    await upload(pid, path.join(media, "m.mp3"));
    calls.length = 0;
    await enqueueJob(pid, "plan", { mode: "ai" });
    await drainQueue();

    expect(calls.filter((c) => c.purpose === "storyboard_repair").length).toBe(1);
    const repairPrompt = calls.find((c) => c.purpose === "storyboard_repair")?.text ?? "";
    expect(repairPrompt).toMatch(/does not exist in this project/);
    const renders = await db.render.findMany({ where: { projectId: pid }, orderBy: { version: "asc" } });
    expect(renders.map((r) => r.status)).toEqual(["failed", "passed"]); // first failed creative QC, auto-fix passed
    expect(renders[1]?.autoFixAttempt).toBe(1);
    expect(fs.existsSync(path.resolve(".test-storage/projects", pid, "renders/v1.mp4"))).toBe(true); // never overwritten
    const sbs = await db.storyboard.findMany({ where: { projectId: pid }, orderBy: { version: "asc" } });
    expect(sbs.map((s) => s.source)).toEqual(["ai", "auto_fix"]);
    const fix = diffStoryboards(parseStoryboardRow(sbs[0]!), parseStoryboardRow(sbs[1]!));
    expect(fix.changed).toEqual(["s1"]);

    // Revision: "make the first 3 seconds more engaging, keep everything else the same"
    const fb = await db.feedback.create({ data: { id: newId(), projectId: pid, message: "Make the first 3 seconds more engaging and keep everything else the same." } });
    await enqueueJob(pid, "revise", { feedbackId: fb.id });
    await drainQueue();
    const after = await db.storyboard.findMany({ where: { projectId: pid }, orderBy: { version: "asc" } });
    expect(after.at(-1)?.source).toBe("revision");
    const d = diffStoryboards(parseStoryboardRow(after.at(-2)!), parseStoryboardRow(after.at(-1)!));
    expect(d.changed).toEqual(["s1"]);
    expect(d.unchanged).toEqual(["s2", "s3"]);
    const last = await db.render.findFirst({ where: { projectId: pid }, orderBy: { version: "desc" } });
    expect(last?.status).toBe("passed");
    expect((await db.feedback.findUnique({ where: { id: fb.id } }))?.status).toBe("applied");
  });

  it("asks a clarification question on conflicting instructions (Test D) and continues after the answer", async () => {
    script.briefClarify = true;
    script.badFirstStoryboard = false;
    const pid = await newProject({ prompt: "Make a 60-second video" });
    await upload(pid, path.join(media, "a.jpg"));
    await upload(pid, path.join(media, "b.png"));
    await enqueueJob(pid, "plan", { mode: "ai" });
    await drainQueue();
    let p = await db.project.findUnique({ where: { id: pid } });
    expect(p?.stage).toBe("needs_clarification");
    expect(p?.stageMessage).toMatch(/8 seconds/);
    expect(await db.storyboard.count({ where: { projectId: pid } })).toBe(0);
    await enqueueJob(pid, "plan", { mode: "ai", clarification: "Keep 8 seconds." });
    await drainQueue();
    p = await db.project.findUnique({ where: { id: pid } });
    expect(p?.stage).toBe("plan_ready");
    script.briefClarify = false;
  });

  it("enforces one active job per project and the model-call budget is tracked", async () => {
    const pid = await newProject();
    await upload(pid, path.join(media, "a.jpg"));
    await enqueueJob(pid, "plan", { mode: "basic" });
    await expect(enqueueJob(pid, "plan", { mode: "basic" })).rejects.toMatchObject({ code: "CONFLICT" });
    await drainQueue();
  });
});
