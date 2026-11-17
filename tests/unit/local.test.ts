import { describe, expect, it } from "vitest";
import { createLocalBrief, extractQuoted, parseDurationSec, callToActionFrom } from "@/server/local/brief";
import { createLocalStoryboard } from "@/server/local/director";
import { planLocalRevision, findAssetRef } from "@/server/local/reviser";
import { frameFeatures, analysisFromFeatures } from "@/server/local/vision";
import { focalInOutput } from "@/server/local/reviewer";
import { applyRevisionOps, diffStoryboards } from "@/server/harness/revision";
import { validateStoryboard } from "@/server/render/storyboardValidation";
import type { AgentAsset, AgentProject } from "@/server/agent/context";
import type { AssetAnalysis, Storyboard } from "@/lib/schemas";
import type { CompileContext, PlanAsset } from "@/server/render/types";

const project = (over: Partial<AgentProject> = {}): AgentProject => ({
  name: "Kerala reel",
  description: "",
  prompt: "",
  platform: "instagram_reels",
  aspectRatio: "9:16",
  durationSec: 30,
  width: 1080,
  height: 1920,
  fps: 30,
  style: "cinematic_travel",
  mood: "",
  language: "English",
  captionsEnabled: true,
  musicPreference: "",
  silentOutput: false,
  ...over,
});

function analysis(hook: number, over: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    summary: "Measured: balanced, warm, vivid, moderate-contrast frame; dominant orange, teal tones; visual focus centre.",
    mainSubject: "Not identified",
    setting: "Not identified",
    people: "Not assessed",
    objects: [],
    composition: "",
    lighting: "",
    dominantColors: ["orange", "teal"],
    visualQuality: "good",
    qualityIssues: [],
    storyRoles: ["b_roll"],
    hookStrength: hook,
    focalPoint: { x: 0.5, y: 0.3 },
    verticalCropSuitability: "good",
    uncertainObservations: [],
    moments: [],
    recommended: true,
    recommendationReason: "",
    analyzer: "local_metrics",
    ...over,
  };
}

const img = (id: string, name: string, hook: number, extra: Partial<AgentAsset> = {}): AgentAsset => ({ id, kind: "image", originalName: name, width: 1600, height: 2000, durationSec: null, hasAudio: false, excluded: false, analysis: analysis(hook), ...extra });

const assets: AgentAsset[] = [
  img("a-0000000001", "street.jpg", 3),
  img("a-0000000002", "beach-sunset.jpg", 5),
  img("a-0000000003", "temple.jpg", 4, { analysis: analysis(4, { dominantColors: ["blue"], summary: "Measured: cool" }) }),
  img("a-0000000004", "boat.jpg", 2),
  img("a-0000000005", "tea-garden.jpg", 3, { analysis: analysis(3, { dominantColors: ["green"] }) }),
  { id: "v-0000000001", kind: "video", originalName: "backwaters.mp4", width: 1920, height: 1080, durationSec: 8, hasAudio: true, excluded: false, analysis: analysis(4, { moments: [{ startSec: 2, endSec: 5, quality: "strong", description: "" }] }) },
  { id: "m-0000000001", kind: "audio", originalName: "track.mp3", width: null, height: null, durationSec: 60, hasAudio: true, excluded: false, audio: { durationSec: 60, peakDb: -1, rmsDb: -14, bpm: 120, bpmConfidence: 0.8, beats: [], energy: Array(120).fill(0.6) } },
];

function ctxFor(durationSec: number): CompileContext {
  const plan: PlanAsset[] = assets.map((a) => ({ id: a.id, kind: a.kind, storedName: `${a.id}.x`, originalName: a.originalName, width: a.width, height: a.height, durationSec: a.durationSec, hasAudio: a.hasAudio, excluded: false, status: "ready" }));
  return { project: { platform: "instagram_reels", width: 1080, height: 1920, fps: 30, durationSec, silentOutput: false }, assets: new Map(plan.map((p) => [p.id, p])), render: { crf: 18, preset: "medium" }, maxOutputDurationSec: 180 };
}

describe("local prompt understanding", () => {
  it("parses durations in many phrasings", () => {
    expect(parseDurationSec("a 30-second reel")).toBe(30);
    expect(parseDurationSec("make it 20 seconds")).toBe(20);
    expect(parseDurationSec("one minute video")).toBe(60);
    expect(parseDurationSec("a thirty second video")).toBe(30);
    expect(parseDurationSec("1.5 min")).toBe(90);
    expect(parseDurationSec("no length here")).toBeNull();
  });
  it("extracts quoted on-screen text and explicit calls to action only", () => {
    expect(extractQuoted('Add "God\'s Own Country" and “See you soon”')).toEqual(["God's Own Country", "See you soon"]);
    expect(callToActionFrom("End with a memorable ending.")).toBeUndefined();
    expect(callToActionFrom('End with the text "Book your trip".')).toBe("Book your trip");
  });
  it("builds a brief from the CLAUDE.md example prompt", () => {
    const b = createLocalBrief({
      project: project({ prompt: "Make a 30-second cinematic Kerala travel reel from these photos and clips. Start with a strong visual hook, build an emotional journey, use elegant text, smooth but not repetitive transitions, warm natural colour grading, and a memorable ending. Keep it premium and not overly flashy." }),
      assets,
    });
    expect(b.needsClarification).toBe(false);
    expect(b.colorGrade).toBe("warm_natural");
    expect(b.typography).toBe("elegant_serif");
    expect(b.mood).toEqual(expect.arrayContaining(["cinematic", "emotional", "premium"]));
    expect(b.avoid.join(" ")).toMatch(/flashy/);
    expect(b.hookIdea).toMatch(/hook/);
  });
  it("detects the 20s vs 60s conflict (Test D) and resolves it from the answer", () => {
    const p = project({ prompt: "Make a 60-second video of these photos.", durationSec: 20 });
    const b = createLocalBrief({ project: p, assets });
    expect(b.needsClarification).toBe(true);
    expect(b.clarificationQuestion).toMatch(/60-second.*20 seconds/);
    expect(createLocalBrief({ project: p, assets, clarification: "60 seconds please" }).durationSec).toBe(60);
    expect(createLocalBrief({ project: p, assets, clarification: "keep the setting" }).durationSec).toBe(20);
  });
  it("reports media limitations (Test C) and silent/music conflicts", () => {
    const weak: AgentAsset[] = [img("w-0000000001", "dark.jpg", 1, { metrics: { brightness: 20, blur: 13, samples: 1, dark: true, veryDark: true, soft: true, blurry: true, notes: [] } }), img("w-0000000002", "tiny.jpg", 2, { width: 480, height: 320 })];
    const b = createLocalBrief({ project: project({ prompt: "Create a beautiful reel with music.", silentOutput: true }), assets: weak });
    expect(b.qualityConcerns.join(" ")).toMatch(/dark|blurry|low-resolution/);
    expect(b.qualityConcerns.join(" ")).toMatch(/won't be presented as true HD/);
    expect(b.conflicts.some((c) => c.topic === "audio")).toBe(true);
  });
});

describe("local director", () => {
  const brief = createLocalBrief({ project: project({ prompt: 'A 30-second cinematic travel reel, not overly flashy. Add "Kerala, slowly".' }), assets });
  const sb = createLocalStoryboard({ project: project(), brief, assets });
  it("produces a valid storyboard that sums to the requested duration", () => {
    expect(validateStoryboard(sb, ctxFor(30)).errors).toEqual([]);
    expect(sb.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(30, 1);
  });
  it("opens on the strongest measured shot and ends deliberately", () => {
    expect(sb.scenes[0]?.assetId).toBe("a-0000000002");
    expect(sb.scenes[0]?.purpose).toBe("Hook");
    expect(sb.scenes.at(-1)?.purpose).toBe("Memorable finish");
    expect(sb.music?.assetId).toBe("m-0000000001");
    expect(sb.music?.beatSync).toBe(true);
  });
  it("varies motion, avoids flashy transitions when asked, uses only the user's words", () => {
    for (let i = 1; i < sb.scenes.length; i++) expect(sb.scenes[i]?.motion === sb.scenes[i - 1]?.motion && sb.scenes[i]?.motion !== "none").toBe(false);
    expect(sb.scenes.every((s) => ["cut", "fade", "dissolve"].includes(s.transitionIn.type))).toBe(true);
    const texts = sb.scenes.map((s) => s.text?.content).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(["Kerala reel", "Kerala, slowly"]));
    expect(texts.every((t) => ["Kerala reel", "Kerala, slowly"].includes(t as string))).toBe(true);
  });
  it("always places text the user asked for, even with few scenes", () => {
    const two = createLocalStoryboard({ project: project({ durationSec: 8, prompt: 'Add "Golden hour". End with the text "See you soon".' }), brief: createLocalBrief({ project: project({ durationSec: 8, prompt: 'Add "Golden hour". End with the text "See you soon".' }), assets: assets.slice(0, 2) }), assets: assets.slice(0, 2) });
    const all = [...two.scenes.map((s) => s.text?.content), two.endCard?.text, two.endCard?.subtext];
    expect(all).toContain("Golden hour");
    expect(two.endCard?.text).toBe("See you soon");
  });
  it("uses the video's strongest moment as its in-point", () => {
    const v = sb.scenes.find((s) => s.assetId === "v-0000000001");
    expect(v?.sourceInSec).toBe(2);
  });
  it("works with a single photo for a long video", () => {
    const one = createLocalStoryboard({ project: project({ durationSec: 60 }), brief: { ...brief, durationSec: 60 }, assets: [img("o-0000000001", "only.jpg", 3)] });
    expect(one.scenes.length).toBeGreaterThan(1);
    expect(one.scenes.every((s) => s.durationSec <= 30)).toBe(true);
  });
});

describe("local revision interpreter (CLAUDE.md examples)", () => {
  const brief = createLocalBrief({ project: project(), assets });
  const sb: Storyboard = createLocalStoryboard({ project: project(), brief, assets });
  const apply = (feedback: string, dur = 30) => {
    const plan = planLocalRevision({ storyboard: sb, feedback, assets, durationSec: dur });
    const setTotal = plan.ops.find((o) => o.op === "set_total_duration");
    const target = setTotal && setTotal.op === "set_total_duration" ? setTotal.durationSec : dur;
    const r = applyRevisionOps(sb, plan.ops, target);
    return { plan, r, target, valid: validateStoryboard(r.storyboard, ctxFor(target)) };
  };

  it('"Make the first 3 seconds more engaging and keep everything else the same" (Test E)', () => {
    const { plan, r, valid } = apply("Make the first 3 seconds more engaging and keep everything else the same.");
    expect(plan.needsClarification).toBe(false);
    expect(valid.errors).toEqual([]);
    const d = diffStoryboards(sb, r.storyboard);
    let t = 0;
    const opening = new Set(sb.scenes.filter((s) => { const st = t; t += s.durationSec; return st < 3; }).map((s) => s.id));
    const outside = d.changed.filter((id) => !opening.has(id));
    expect(d.changed.some((id) => opening.has(id))).toBe(true);
    expect(outside.length).toBeLessThanOrEqual(1); // at most one neighbour absorbs timing
    expect(r.storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(30, 1);
  });
  it('"Use the beach photo first"', () => {
    const plan = planLocalRevision({ storyboard: { ...sb, scenes: [...sb.scenes].reverse() }, feedback: "Use the beach photo first", assets, durationSec: 30 });
    expect(plan.ops.some((o) => o.op === "move_scene" || o.op === "update_scene")).toBe(true);
    expect(findAssetRef("the beach photo", assets, sb)?.id).toBe("a-0000000002");
  });
  it('"Reduce the transitions"', () => {
    const { r, valid } = apply("Reduce the transitions.");
    expect(valid.errors).toEqual([]);
    expect(r.storyboard.scenes.slice(1).every((s) => s.transitionIn.type === "cut" || (s.transitionIn.type === "fade" && s.transitionIn.durationSec <= 0.6))).toBe(true);
  });
  it('"Make the text smaller"', () => {
    const { r } = apply("Make the text smaller.");
    expect(r.storyboard.textScale).toBeLessThan(1);
  });
  it('"Make the colours more natural"', () => {
    const { r } = apply("Make the colours more natural.");
    expect(r.storyboard.colorGrade).toBe("natural");
  });
  it('"Use a slower, emotional pace"', () => {
    const { r, valid } = apply("Use a slower, emotional pace.");
    expect(valid.errors).toEqual([]);
    expect(r.storyboard.scenes.length).toBeLessThan(sb.scenes.length);
    expect(r.storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(30, 1);
  });
  it('"Remove this clip" asks which one; "remove scene 2" works', () => {
    expect(planLocalRevision({ storyboard: sb, feedback: "Remove this clip.", assets: assets.map((a) => ({ ...a, originalName: "IMG_0001.jpg" })), durationSec: 30 }).needsClarification).toBe(true);
    const { r, valid } = apply("remove scene 2");
    expect(valid.errors).toEqual([]);
    expect(r.storyboard.scenes.length).toBe(sb.scenes.length - 1);
  });
  it('"Make it 20 seconds"', () => {
    const { target, r, valid } = apply("Make it 20 seconds.");
    expect(target).toBe(20);
    expect(valid.errors).toEqual([]);
    expect(r.storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(20, 1);
  });
  it("faster pace, music, ending and quoted text", () => {
    expect(apply("Make it faster and more energetic").valid.errors).toEqual([]);
    expect(apply("lower the music").r.storyboard.music?.volume).toBeLessThan(sb.music!.volume);
    expect(apply('End with "See you in Kerala"').r.storyboard.endCard?.text).toBe("See you in Kerala");
    expect(apply("no music").r.storyboard.music).toBeNull();
  });
  it("text background and text animation requests", () => {
    const withCaption = { ...sb, scenes: sb.scenes.map((s, i) => (i === 1 ? { ...s, text: { content: "Hello", style: "caption" as const, position: "top" as const, animation: "fade" as const } } : s)) };
    const p1 = planLocalRevision({ storyboard: withCaption, feedback: "Put a background behind the captions", assets, durationSec: 30 });
    const r1 = applyRevisionOps(withCaption, p1.ops, 30);
    expect(r1.storyboard.scenes[1]?.text?.style).toBe("label");
    const p2 = planLocalRevision({ storyboard: withCaption, feedback: "Use a typewriter effect for the text", assets, durationSec: 30 });
    expect(applyRevisionOps(withCaption, p2.ops, 30).storyboard.scenes[1]?.text?.animation).toBe("typewriter");
  });
  it("asks for clarification on requests it cannot map", () => {
    const p = planLocalRevision({ storyboard: sb, feedback: "Make it feel like Tuesday.", assets, durationSec: 30 });
    expect(p.needsClarification).toBe(true);
  });
});

describe("local vision", () => {
  it("finds the focal point of a bright subject and scores hooks", () => {
    // 96×96 dark grey frame with a bright red square in the upper-right.
    const w = 96;
    const h = 96;
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const inSq = x >= 60 && x < 84 && y >= 12 && y < 36;
        data[i] = inSq ? 230 : 60;
        data[i + 1] = inSq ? 40 : 60;
        data[i + 2] = inSq ? 40 : 64;
      }
    const f = frameFeatures({ w, h, data }, 1);
    expect(f.focal.x).toBeGreaterThan(0.6);
    expect(f.focal.y).toBeLessThan(0.4);
    expect(f.colors.map((c) => c.name)).toEqual(expect.arrayContaining(["red"]));
    const a = analysisFromFeatures({ f, width: 2000, height: 2000, kind: "image" });
    expect(a.analyzer).toBe("local_metrics");
    expect(a.mainSubject).toMatch(/Not identified/);
    expect(a.hookStrength).toBeGreaterThanOrEqual(1);
  });
  it("maps focal points into the output for contain_blur framing", () => {
    const clip = { focus: { x: 0.5, y: 0.5 }, fit: "contain_blur", sourceWidth: 1600, sourceHeight: 900 } as never;
    const f = focalInOutput(clip, 1080, 1920);
    expect(f.x).toBeCloseTo(0.5, 2);
    expect(f.y).toBeCloseTo(0.5, 2);
  });
});
