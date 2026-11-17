import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSynthetic } from "@/server/dev/synthetic";
import { probeMedia } from "@/server/media/probe";
import { analyseAudioFile } from "@/server/media/audio";
import { compileStoryboard } from "@/server/render/compiler";
import { validateEdl } from "@/server/render/edlValidation";
import { validateStoryboard } from "@/server/render/storyboardValidation";
import { renderEdl } from "@/server/render/renderer";
import { ensureProjectDirs, resolveProjectPath } from "@/server/storage";
import type { CompileContext, PlanAsset } from "@/server/render/types";
import type { Storyboard } from "@/lib/schemas";

const PROJECT = "render-test-0001";
let ctx: CompileContext;
const ids = { p1: "asset-photo-0001", p2: "asset-photo-0002", v1: "asset-video-0001", m1: "asset-music-0001" };

beforeAll(async () => {
  const root = ensureProjectDirs(PROJECT);
  const orig = path.join(root, "originals");
  await makeSynthetic("photo_landscape", orig, `${ids.p1}.jpg`, 1);
  await makeSynthetic("photo_portrait", orig, `${ids.p2}.png`, 2);
  await makeSynthetic("clip_landscape", orig, `${ids.v1}.mp4`, 3);
  await makeSynthetic("music_120bpm", orig, `${ids.m1}.mp3`);
  const assets = new Map<string, PlanAsset>();
  for (const [id, name, kind] of [
    [ids.p1, `${ids.p1}.jpg`, "image"],
    [ids.p2, `${ids.p2}.png`, "image"],
    [ids.v1, `${ids.v1}.mp4`, "video"],
    [ids.m1, `${ids.m1}.mp3`, "audio"],
  ] as const) {
    const info = await probeMedia(path.join(orig, name));
    const a: PlanAsset = {
      id,
      kind,
      storedName: name,
      originalName: name,
      width: info.video?.displayWidth ?? null,
      height: info.video?.displayHeight ?? null,
      durationSec: kind === "image" ? null : info.durationSec,
      hasAudio: info.audio !== null,
      excluded: false,
      status: "ready",
    };
    if (kind === "audio") {
      const an = await analyseAudioFile(path.join(orig, name), path.join(root, "work"));
      a.beats = an.beats;
      a.bpm = an.bpm;
    }
    assets.set(id, a);
  }
  ctx = {
    project: { platform: "instagram_reels", width: 1080, height: 1920, fps: 30, durationSec: 8, silentOutput: false },
    assets,
    render: { crf: 20, preset: "ultrafast" },
    maxOutputDurationSec: 180,
  };
});

function storyboard(): Storyboard {
  const base = { fit: "cover" as const, focus: null, motionIntensity: "medium" as const, useClipAudio: false, clipAudioVolume: 0, visualDescription: "", musicCue: "", reason: "test" };
  return {
    title: "Test reel",
    logline: "test",
    colorGrade: "warm_natural",
    gradeIntensity: 0.8,
    typography: "elegant_serif",
    music: { assetId: ids.m1, startSec: 0, volume: 0.9, beatSync: true },
    endCard: { text: "See you soon", subtext: "Kerala 2026" },
    fadeOutEnding: true,
    scenes: [
      { ...base, id: "s1", purpose: "Hook", durationSec: 2.5, assetId: ids.p1, sourceInSec: 0, motion: "push_in", transitionIn: { type: "fade", durationSec: 0.5 }, text: { content: "Welcome to God's Own Country", style: "title", position: "center", animation: "rise" } },
      { ...base, id: "s2", purpose: "Setting", durationSec: 2.5, assetId: ids.v1, sourceInSec: 1, motion: "none", fit: "contain_blur", transitionIn: { type: "dissolve", durationSec: 0.6 }, useClipAudio: true, clipAudioVolume: 0.5, text: { content: "Backwaters at dawn", style: "caption", position: "lower_third", animation: "fade" } },
      { ...base, id: "s3", purpose: "Finish", durationSec: 3, assetId: ids.p2, sourceInSec: 0, motion: "pan_up", transitionIn: { type: "smooth_left", durationSec: 0.5 }, text: null },
    ],
  };
}

describe("render pipeline (real FFmpeg)", () => {
  it("validates, compiles and renders a playable vertical MP4 with text, music and transitions", async () => {
    const sb = storyboard();
    const sv = validateStoryboard(sb, ctx);
    expect(sv.errors).toEqual([]);
    const { edl } = compileStoryboard(sb, ctx);
    const ev = validateEdl(edl, ctx, PROJECT);
    expect(ev.errors).toEqual([]);
    expect(edl.output.totalFrames).toBe(240);
    const progress: number[] = [];
    const out = await renderEdl(PROJECT, edl, 1, { workName: "test_r1", onProgress: (p) => progress.push(p.fraction) });
    const abs = resolveProjectPath(PROJECT, out.outputRel);
    expect(fs.statSync(abs).size).toBeGreaterThan(10_000);
    const info = await probeMedia(abs);
    expect(info.video?.width).toBe(1080);
    expect(info.video?.height).toBe(1920);
    expect(info.video?.codec).toBe("h264");
    expect(info.video?.fps).toBeCloseTo(30, 1);
    expect(info.audio?.codec).toBe("aac");
    expect(Math.abs((info.durationSec ?? 0) - 8)).toBeLessThan(0.15);
    expect(out.loudnessMeasured).toBe(true);
    // Progress is monotonic-ish and reaches 1.
    expect(progress[progress.length - 1]).toBe(1);
    // Never overwrite an existing render.
    await expect(renderEdl(PROJECT, edl, 1, { workName: "test_r1b" })).rejects.toThrow(/refusing to overwrite/);
  });

  it("renders silent output without an audio stream", async () => {
    const sb = { ...storyboard(), music: null };
    sb.scenes = sb.scenes.map((s) => ({ ...s, useClipAudio: false }));
    const silentCtx = { ...ctx, project: { ...ctx.project, silentOutput: true } };
    const { edl } = compileStoryboard(sb, silentCtx);
    expect(edl.expectsAudio).toBe(false);
    const ev = validateEdl(edl, silentCtx, PROJECT);
    expect(ev.errors).toEqual([]);
    const out = await renderEdl(PROJECT, edl, 2, { workName: "test_r2" });
    const info = await probeMedia(resolveProjectPath(PROJECT, out.outputRel));
    expect(info.audio).toBeNull();
    expect(info.video?.height).toBe(1920);
  });
});
