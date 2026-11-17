import { describe, expect, it } from "vitest";
import { checkSignature, detectFormat } from "@/server/media/signature";
import { readJpegOrientation, parseRate } from "@/server/media/probe";
import { resolveProjectPath, sanitizeDisplayName } from "@/server/storage";
import { signUserId, verifySessionValue } from "@/server/auth";
import { canTransition } from "@/server/harness/stateMachine";
import { sanitizeAssText } from "@/server/render/ass";
import { analyseSamples } from "@/server/media/audio";
import { summarizeMetrics } from "@/server/media/derive";
import { gradeFilter, exposureFixFor } from "@/server/render/grades";
import { outputDimensions, safeArea } from "@/lib/presets";

describe("file signature validation", () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(52)]);
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(52)]);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(52)]);
  const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(62)]);

  it("detects supported formats from content", () => {
    expect(detectFormat(jpg)).toBe("jpeg");
    expect(detectFormat(png)).toBe("png");
    expect(detectFormat(mp4)).toBe("mp4");
    expect(detectFormat(mov)).toBe("mov");
    expect(detectFormat(wav)).toBe("wav");
    expect(detectFormat(exe)).toBeUndefined();
  });
  it("requires extension and content to agree", () => {
    expect(checkSignature("photo.jpg", jpg).ok).toBe(true);
    expect(checkSignature("clip.mov", mp4).ok).toBe(true); // MOV/MP4 share ISO-BMFF
    expect(checkSignature("photo.png", jpg).ok).toBe(false);
    expect(checkSignature("photo.jpg", exe).ok).toBe(false);
    expect(checkSignature("script.sh", exe).ok).toBe(false);
    expect(checkSignature("noext", jpg).ok).toBe(false);
  });
});

describe("storage path safety", () => {
  const pid = "abcdef12-3456-7890-abcd-ef1234567890";
  it("resolves allowed project paths", () => {
    expect(resolveProjectPath(pid, "originals/x.jpg")).toContain(`${pid}/originals/x.jpg`);
  });
  it.each(["../secret", "originals/../../etc/passwd", "/etc/passwd", "originals/\0x", "random/file", "originals"])("rejects %s", (rel) => {
    expect(() => resolveProjectPath(pid, rel)).toThrow();
  });
  it("rejects unsafe project ids", () => {
    expect(() => resolveProjectPath("../../x", "originals/a.jpg")).toThrow();
  });
  it("sanitises display names", () => {
    expect(sanitizeDisplayName("../../evil<script>.jpg")).toBe("evilscript.jpg");
    expect(sanitizeDisplayName("C:\\Users\\me\\beach.jpg")).toBe("beach.jpg");
  });
});

describe("session signing", () => {
  it("round-trips and rejects tampering", () => {
    const v = signUserId("user-123456789");
    expect(verifySessionValue(v)).toBe("user-123456789");
    expect(verifySessionValue(v.replace("user-123456789", "user-999999999"))).toBeUndefined();
    expect(verifySessionValue("garbage")).toBeUndefined();
  });
});

describe("workflow state machine", () => {
  it("allows the normal flow and blocks skipping render", () => {
    expect(canTransition("draft", "planning")).toBe(true);
    expect(canTransition("planning", "plan_ready")).toBe(true);
    expect(canTransition("plan_ready", "rendering")).toBe(true);
    expect(canTransition("rendering", "completed")).toBe(true);
    expect(canTransition("draft", "completed")).toBe(false);
    expect(canTransition("planning", "completed")).toBe(false);
    expect(canTransition("analysing", "completed")).toBe(false);
  });
});

describe("media helpers", () => {
  it("parses frame rates", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRate("0/0")).toBeNull();
  });
  it("reads EXIF orientation from JPEG APP1", () => {
    const tiff = Buffer.concat([Buffer.from("MM\0*"), Buffer.from([0, 0, 0, 8]), Buffer.from([0, 1]), Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]), Buffer.alloc(4)]);
    const app1Body = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(app1Body.length + 2);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1Body, Buffer.from([0xff, 0xda, 0, 2])]);
    expect(readJpegOrientation(jpg)).toBe(6);
    expect(readJpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
  });
  it("flags dark and blurry media from metrics", () => {
    const m = summarizeMetrics([30, 32], [13, 14]);
    expect(m.veryDark).toBe(true);
    expect(m.blurry).toBe(true);
    expect(summarizeMetrics([120], [5]).notes).toEqual([]);
  });
  it("detects tempo and beats on a synthetic 120 BPM click track", () => {
    const sr = 11025;
    const s = new Float32Array(sr * 12);
    for (let i = 0; i < s.length; i++) {
      const t = i / sr;
      s[i] = 0.6 * Math.sin(2 * Math.PI * 200 * t) * Math.exp(-12 * (t % 0.5));
    }
    const a = analyseSamples(s, sr);
    expect(a.bpm).not.toBeNull();
    expect(Math.abs((a.bpm as number) - 120)).toBeLessThan(3);
    expect(a.beats.length).toBeGreaterThan(18);
    // Beats land near multiples of 0.5 s.
    const off = a.beats.map((b) => Math.min(b % 0.5, 0.5 - (b % 0.5)));
    expect(Math.max(...off.slice(1, 10))).toBeLessThan(0.06);
    expect(a.peakDb).toBeLessThan(0);
  });
  it("returns no tempo for silence", () => {
    const a = analyseSamples(new Float32Array(11025 * 6), 11025);
    expect(a.bpm).toBeNull();
  });
});

describe("typography + grading safety", () => {
  it("prevents ASS override injection", () => {
    const s = sanitizeAssText("Hello {\\pos(0,0)\\c&H0000FF&} world\\N\nnext");
    expect(s).not.toContain("{");
    expect(s).not.toContain("}");
    expect(s).not.toContain("\\");
    expect(s).not.toContain("\n");
  });
  it("bounds grade parameters", () => {
    const f = gradeFilter("vibrant", 5, 0.5);
    const sat = Number(/saturation=([\d.]+)/.exec(f)?.[1]);
    const bri = Number(/brightness=(-?[\d.]+)/.exec(f)?.[1]);
    expect(sat).toBeLessThanOrEqual(1.6);
    expect(bri).toBeLessThanOrEqual(0.2);
    expect(exposureFixFor(30)).toBeGreaterThan(0);
    expect(exposureFixFor(128)).toBe(0);
  });
  it("computes output sizes and safe areas", () => {
    expect(outputDimensions("9:16", "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(outputDimensions("16:9", "2160p")).toEqual({ width: 3840, height: 2160 });
    expect(outputDimensions("4:5", "1080p")).toEqual({ width: 1080, height: 1350 });
    const sa = safeArea("instagram_reels", 1080, 1920);
    expect(sa.bottom).toBeGreaterThan(sa.top);
  });
});
