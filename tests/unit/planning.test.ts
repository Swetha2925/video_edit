import { describe, expect, it } from "vitest";
import type { Edl, Scene, Storyboard } from "@/lib/schemas";
import { compileStoryboard, snapBoundariesToBeats } from "@/server/render/compiler";
import { validateEdl } from "@/server/render/edlValidation";
import { normalizeDurations, validateStoryboard } from "@/server/render/storyboardValidation";
import { applyRevisionOps, diffStoryboards } from "@/server/harness/revision";
import { layoutText, styleSpec } from "@/server/render/textLayout";
import { evaluateTechnical, reviewTimestamps, unexpectedPortion } from "@/server/qc/checks";
import type { RenderInspection } from "@/server/qc/inspect";
import type { CompileContext, PlanAsset } from "@/server/render/types";
import { heuristicStoryboard } from "@/server/agent/heuristicPlanner";

const PID = "unit-test-project-01";
const asset = (id: string, kind: PlanAsset["kind"], extra: Partial<PlanAsset> = {}): PlanAsset => ({
  id,
  kind,
  storedName: `${id}.${kind === "image" ? "jpg" : kind === "video" ? "mp4" : "mp3"}`,
  originalName: `${id}.file`,
  width: kind === "audio" ? null : 1600,
  height: kind === "audio" ? null : 1066,
  durationSec: kind === "image" ? null : kind === "video" ? 6 : 40,
  hasAudio: kind !== "image",
  excluded: false,
  status: "ready",
  ...extra,
});

function ctx(over: Partial<CompileContext["project"]> = {}): CompileContext {
  const list = [asset("img-aaaaaaa1", "image"), asset("img-aaaaaaa2", "image", { width: 4000, height: 6000 }), asset("vid-aaaaaaa1", "video"), asset("mus-aaaaaaa1", "audio", { beats: Array.from({ length: 80 }, (_, i) => i * 0.5), bpm: 120 }), asset("img-excluded", "image", { excluded: true })];
  return {
    project: { platform: "instagram_reels", width: 1080, height: 1920, fps: 30, durationSec: 10, silentOutput: false, ...over },
    assets: new Map(list.map((a) => [a.id, a])),
    render: { crf: 18, preset: "medium" },
    maxOutputDurationSec: 180,
  };
}

const scene = (id: string, assetId: string, durationSec: number, extra: Partial<Scene> = {}): Scene => ({
  id,
  purpose: id,
  durationSec,
  assetId,
  sourceInSec: 0,
  fit: "cover",
  focus: null,
  motion: "push_in",
  motionIntensity: "subtle",
  transitionIn: { type: "fade", durationSec: 0.5 },
  text: null,
  useClipAudio: false,
  clipAudioVolume: 0,
  visualDescription: "",
  musicCue: "",
  reason: "",
  ...extra,
});

function sb(scenes: Scene[], extra: Partial<Storyboard> = {}): Storyboard {
  return { title: "t", logline: "", colorGrade: "warm_natural", gradeIntensity: 0.7, typography: "elegant_serif", music: null, endCard: null, fadeOutEnding: true, scenes, ...extra };
}

describe("storyboard validation", () => {
  it("accepts a valid plan", () => {
    const r = validateStoryboard(sb([scene("s1", "img-aaaaaaa1", 4), scene("s2", "vid-aaaaaaa1", 3, { sourceInSec: 1 }), scene("s3", "img-aaaaaaa2", 3)]), ctx());
    expect(r.errors).toEqual([]);
  });
  it("rejects invalid asset ids, excluded assets, audio as visual, bad in-points and wrong totals", () => {
    const r = validateStoryboard(
      sb([scene("s1", "missing-asset-id", 2), scene("s2", "img-excluded", 2), scene("s3", "mus-aaaaaaa1", 2), scene("s4", "vid-aaaaaaa1", 2, { sourceInSec: 50 })]),
      ctx(),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/does not exist/);
    expect(r.errors.join(" ")).toMatch(/excluded/);
    expect(r.errors.join(" ")).toMatch(/audio file/);
    expect(r.errors.join(" ")).toMatch(/beyond the clip/);
    expect(r.errors.join(" ")).toMatch(/requested/);
  });
  it("rejects negative/zero durations and duplicate ids via schema", () => {
    expect(validateStoryboard(sb([scene("s1", "img-aaaaaaa1", -1)]), ctx()).valid).toBe(false);
    expect(validateStoryboard(sb([scene("s1", "img-aaaaaaa1", 5), scene("s1", "img-aaaaaaa2", 5)]), ctx()).errors.join(" ")).toMatch(/duplicate/);
  });
  it("rejects music when silent output is requested", () => {
    const r = validateStoryboard(sb([scene("s1", "img-aaaaaaa1", 10)], { music: { assetId: "mus-aaaaaaa1", startSec: 0, volume: 1, beatSync: false } }), ctx({ silentOutput: true }));
    expect(r.errors.join(" ")).toMatch(/silent/);
  });
  it("normalises durations to the exact target", () => {
    const n = normalizeDurations(sb([scene("s1", "img-aaaaaaa1", 3), scene("s2", "img-aaaaaaa2", 4)]), 10);
    expect(n.changed).toBe(true);
    expect(n.storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(10, 5);
  });
});

describe("EDL compiler", () => {
  it("produces frame-exact timing with centred transition overlaps", () => {
    const { edl } = compileStoryboard(sb([scene("s1", "img-aaaaaaa1", 4), scene("s2", "vid-aaaaaaa1", 3, { sourceInSec: 1 }), scene("s3", "img-aaaaaaa2", 3, { transitionIn: { type: "cut", durationSec: 0 } })]), ctx());
    expect(edl.output.totalFrames).toBe(300);
    const [c1, c2, c3] = edl.clips as [Edl["clips"][0], Edl["clips"][0], Edl["clips"][0]];
    expect(c1.transitionIn.frames).toBe(0);
    expect(c2.transitionIn.frames).toBe(14); // 0.5 s = 15 frames → rounded down to even 14
    expect(c3.transitionIn).toEqual({ type: "cut", frames: 0 });
    // Clips exactly cover the timeline.
    expect(c3.timelineStartFrame + c3.frames).toBe(300);
    expect(c2.timelineStartFrame).toBe(120 - 7);
    // Video in-point moves back by half the transition.
    expect(c2.inSec).toBeCloseTo(1 - 7 / 30, 3);
    expect(validateEdl(edl, ctx(), PID, { checkFiles: false }).errors).toEqual([]);
  });
  it("snaps cuts to nearby beats but respects minimum scene length", () => {
    const snapped = snapBoundariesToBeats([0, 62, 128, 300], [2, 4.3, 6], 30, 300);
    expect(snapped).toEqual([0, 60, 129, 300]);
    const { edl, warnings } = compileStoryboard(
      sb([scene("s1", "img-aaaaaaa1", 3.1), scene("s2", "img-aaaaaaa2", 3.3), scene("s3", "img-aaaaaaa1", 3.6)], { music: { assetId: "mus-aaaaaaa1", startSec: 0, volume: 1, beatSync: true } }),
      ctx(),
    );
    expect(warnings.join(" ")).toMatch(/Snapped/);
    const b1 = (edl.clips[1] as Edl["clips"][0]).timelineStartFrame + (edl.clips[1] as Edl["clips"][0]).transitionIn.frames / 2;
    expect(b1 % 15).toBe(0); // 0.5 s beat grid at 30 fps
    expect(edl.music?.assetId).toBe("mus-aaaaaaa1");
    expect(edl.expectsAudio).toBe(true);
  });
  it("holds the last frame (with a warning) when a clip is too short", () => {
    const { edl, warnings } = compileStoryboard(sb([scene("s1", "vid-aaaaaaa1", 10, { motion: "none" })]), ctx());
    expect(warnings.join(" ")).toMatch(/held/);
    expect(edl.intentional.staticRanges.length).toBe(1);
  });
  it("marks upscaled sources honestly", () => {
    const c = ctx();
    c.assets.set("img-small001", asset("img-small001", "image", { width: 480, height: 320 }));
    const { edl } = compileStoryboard(sb([scene("s1", "img-small001", 10)]), c);
    expect(edl.clips[0]?.upscaled).toBe(true);
    const { edl: big } = compileStoryboard(sb([scene("s1", "img-aaaaaaa2", 10)]), c);
    expect(big.clips[0]?.upscaled).toBe(false);
  });
  it("lays out text inside the safe area at readable sizes", () => {
    const { edl } = compileStoryboard(sb([scene("s1", "img-aaaaaaa1", 10, { text: { content: "A very long headline that must wrap onto several lines to fit", style: "title", position: "top", animation: "rise" } })], { endCard: { text: "See you soon", subtext: "Kerala" } }), ctx());
    const v = validateEdl(edl, ctx(), PID, { checkFiles: false });
    expect(v.errors).toEqual([]);
    const t = edl.texts[0];
    expect(t?.lines.length).toBeGreaterThan(1);
    expect(t && t.box.left >= edl.safeArea.left - 1 && t.box.right <= 1080 - edl.safeArea.right + 1).toBe(true);
    expect(edl.texts.some((x) => x.id === "end_title")).toBe(true);
  });
});

describe("EDL validation rejects unsafe or broken EDLs", () => {
  const base = () => compileStoryboard(sb([scene("s1", "img-aaaaaaa1", 5), scene("s2", "img-aaaaaaa2", 5)]), ctx()).edl;
  it("rejects path traversal and foreign assets", () => {
    const e = base();
    (e.clips[0] as { source: string }).source = "originals/../../etc/passwd.jpg";
    expect(validateEdl(e, ctx(), PID, { checkFiles: false }).valid).toBe(false);
    const e2 = base();
    (e2.clips[0] as { assetId: string }).assetId = "someone-elses-asset";
    expect(validateEdl(e2, ctx(), PID, { checkFiles: false }).errors.join(" ")).toMatch(/not part of this project/);
  });
  it("rejects unsupported effects, negative frames and timeline gaps", () => {
    const e = base();
    (e.clips[1] as { transitionIn: { type: string; frames: number } }).transitionIn = { type: "explode", frames: 10 };
    expect(validateEdl(e, ctx(), PID, { checkFiles: false }).valid).toBe(false);
    const e2 = base();
    (e2.clips[0] as { frames: number }).frames = -5;
    expect(validateEdl(e2, ctx(), PID, { checkFiles: false }).valid).toBe(false);
    const e3 = base();
    (e3.clips[1] as { timelineStartFrame: number }).timelineStartFrame += 7;
    expect(validateEdl(e3, ctx(), PID, { checkFiles: false }).errors.join(" ")).toMatch(/timeline start/);
  });
  it("rejects unreadably small text and output mismatches", () => {
    const e = compileStoryboard(sb([scene("s1", "img-aaaaaaa1", 10, { text: { content: "Hi", style: "caption", position: "center", animation: "fade" } })]), ctx()).edl;
    (e.texts[0] as { sizePx: number }).sizePx = 18;
    expect(validateEdl(e, ctx(), PID, { checkFiles: false }).errors.join(" ")).toMatch(/readable minimum/);
    const e2 = base();
    e2.output.width = 720;
    expect(validateEdl(e2, ctx(), PID, { checkFiles: false }).valid).toBe(false);
  });
});

describe("revision patches", () => {
  const original = sb([scene("s1", "img-aaaaaaa1", 3), scene("s2", "img-aaaaaaa2", 3), scene("s3", "vid-aaaaaaa1", 4)]);
  it("changes only targeted scenes", () => {
    const r = applyRevisionOps(original, [{ op: "update_scene", sceneId: "s1", changes: { motion: "pull_out", motionIntensity: "strong", text: { content: "Wow", style: "title", position: "center", animation: "fade_scale" } } }], 10);
    expect(r.errors).toEqual([]);
    const d = diffStoryboards(original, r.storyboard);
    expect(d.changed).toEqual(["s1"]);
    expect(d.unchanged).toEqual(["s2", "s3"]);
  });
  it("moves, removes, inserts and rescales", () => {
    const r = applyRevisionOps(
      original,
      [
        { op: "move_scene", sceneId: "s2", afterSceneId: null },
        { op: "remove_scene", sceneId: "s3" },
        { op: "insert_scene", afterSceneId: "s1", scene: scene("s9", "img-aaaaaaa1", 4) },
        { op: "set_total_duration", durationSec: 20 },
      ],
      10,
    );
    expect(r.errors).toEqual([]);
    expect(r.storyboard.scenes.map((s) => s.id)).toEqual(["s2", "s1", "s9"]);
    expect(r.storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(20, 5);
  });
  it("reports unknown scenes and duration drift", () => {
    expect(applyRevisionOps(original, [{ op: "remove_scene", sceneId: "nope" }], 10).errors.length).toBe(1);
    expect(applyRevisionOps(original, [{ op: "update_scene", sceneId: "s1", changes: { durationSec: 9 } }], 10).errors.join(" ")).toMatch(/total duration/);
  });
});

describe("heuristic (no-AI) planner", () => {
  it("opens on the best measured shot and fills the duration", () => {
    const assets = [
      { id: "dark-asset01", kind: "image" as const, originalName: "dark.jpg", width: 1600, height: 1066, durationSec: null, hasAudio: false, excluded: false, metrics: { brightness: 20, blur: 5, samples: 1, dark: true, veryDark: true, soft: false, blurry: false, notes: [] } },
      { id: "good-asset01", kind: "image" as const, originalName: "good.jpg", width: 3000, height: 4000, durationSec: null, hasAudio: false, excluded: false, metrics: { brightness: 120, blur: 5, samples: 1, dark: false, veryDark: false, soft: false, blurry: false, notes: [] } },
    ];
    const plan = heuristicStoryboard({ projectName: "Test", style: "cinematic_travel", durationSec: 9, width: 1080, height: 1920, captionsEnabled: true, silentOutput: false, assets });
    expect(plan.scenes[0]?.assetId).toBe("good-asset01");
    expect(plan.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(9, 5);
  });
});

describe("text layout", () => {
  it("shrinks long text down to a minimum and reports fit", () => {
    const spec = styleSpec("caption", "modern_sans");
    const safe = { top: 230, bottom: 422, left: 65, right: 130 };
    const ok = layoutText("Backwaters at dawn", spec, "lower_third", { width: 1080, height: 1920 }, safe);
    expect(ok.fits).toBe(true);
    expect(ok.lines).toHaveLength(1);
    const long = layoutText("word ".repeat(40), spec, "lower_third", { width: 1080, height: 1920 }, safe);
    expect(long.fits).toBe(false);
  });
});

describe("QC evaluation", () => {
  const { edl } = compileStoryboard(sb([scene("s1", "img-aaaaaaa1", 5, { transitionIn: { type: "fade_black", durationSec: 0.6 } }), scene("s2", "img-aaaaaaa2", 5, { transitionIn: { type: "fade_black", durationSec: 0.6 } })], { music: { assetId: "mus-aaaaaaa1", startSec: 0, volume: 1, beatSync: false } }), ctx());
  const good: RenderInspection = {
    exists: true,
    sizeBytes: 5_000_000,
    info: { formatName: "mp4", durationSec: 10, sizeBytes: 5_000_000, video: { codec: "h264", width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixFmt: "yuv420p", isStillImage: false }, audio: { codec: "aac", sampleRate: 48000, channels: 2, durationSec: 10 } },
    probeError: null,
    decodeErrors: [],
    black: [[4.75, 5.2]],
    frozen: [],
    silence: [[9.4, 10]],
    meanVolumeDb: -16,
    maxVolumeDb: -2,
    tailRmsDb: -40,
    bitrateKbps: 4000,
  };
  it("passes a correct render and ignores intentional fades", () => {
    const ev = evaluateTechnical(good, edl);
    expect(ev.blockingFailures).toBe(0);
    expect(ev.issues).toEqual([]);
  });
  it("never reports success for missing, wrong-size, silent or black output", () => {
    expect(evaluateTechnical({ ...good, exists: false, sizeBytes: 0, info: null }, edl).blockingFailures).toBeGreaterThan(0);
    const wrong = { ...good, info: { ...good.info!, video: { ...good.info!.video!, width: 720, height: 1280 } } };
    expect(evaluateTechnical(wrong, edl).technical.find((c) => c.id === "resolution")?.status).toBe("fail");
    expect(evaluateTechnical({ ...good, info: { ...good.info!, audio: null } }, edl).blockingFailures).toBeGreaterThan(0);
    expect(evaluateTechnical({ ...good, silence: [[2, 6]] }, edl).blockingFailures).toBeGreaterThan(0);
    expect(evaluateTechnical({ ...good, black: [[1, 3]] }, edl).blockingFailures).toBeGreaterThan(0);
    expect(evaluateTechnical({ ...good, maxVolumeDb: 0 }, edl).issues.some((i) => /clipping/.test(i.description))).toBe(true);
    expect(evaluateTechnical({ ...good, info: { ...good.info!, durationSec: 12 } }, edl).blockingFailures).toBeGreaterThan(0);
  });
  it("computes unexpected portions and review timestamps", () => {
    expect(unexpectedPortion([1, 2], [[0, 3]])).toBe(0);
    expect(unexpectedPortion([1, 4], [[0, 2]], 0)).toBe(2);
    const times = reviewTimestamps(edl);
    expect(times[0]).toBeLessThan(1);
    expect(times.length).toBeGreaterThanOrEqual(3);
  });
});
