import fs from "node:fs";
import path from "node:path";
import { ffmpegPath } from "../media/binaries";
import { runProcess } from "../media/process";

/**
 * Synthetic media generator for tests, evals and the offline demo. Everything is
 * generated locally with FFmpeg — no downloads, no licensing questions.
 */
export type SyntheticKind =
  | "photo_landscape"
  | "photo_portrait"
  | "photo_square"
  | "photo_dark"
  | "photo_blurry"
  | "photo_small"
  | "clip_landscape"
  | "clip_portrait"
  | "music_120bpm"
  | "corrupt_mp4"
  | "fake_jpg";

const run = (args: string[]) => runProcess(ffmpegPath(), ["-hide_banner", "-v", "error", "-y", ...args], { timeoutMs: 120_000 });

/** Generate one synthetic asset. `seed` varies colours/patterns so files differ. */
export async function makeSynthetic(kind: SyntheticKind, dir: string, name: string, seed = 0): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  const hue = (seed * 47) % 360;
  const scene = (w: number, h: number, extra = "") =>
    `mandelbrot=s=${w}x${h}:start_scale=${(3 - (seed % 5) * 0.4).toFixed(2)}:end_pts=1,hue=h=${hue}:s=1.3${extra}`;
  switch (kind) {
    case "photo_landscape":
      await run(["-f", "lavfi", "-i", scene(1600, 1066), "-frames:v", "1", "-q:v", "3", out]);
      break;
    case "photo_portrait":
      await run(["-f", "lavfi", "-i", scene(1080, 1440), "-frames:v", "1", out]);
      break;
    case "photo_square":
      await run(["-f", "lavfi", "-i", `testsrc2=s=1200x1200,hue=h=${hue}`, "-frames:v", "1", "-q:v", "3", out]);
      break;
    case "photo_dark":
      await run(["-f", "lavfi", "-i", scene(1600, 1066, ",eq=brightness=-0.45:contrast=0.6"), "-frames:v", "1", "-q:v", "3", out]);
      break;
    case "photo_blurry":
      await run(["-f", "lavfi", "-i", scene(1600, 1066, ",gblur=sigma=9"), "-frames:v", "1", "-q:v", "3", out]);
      break;
    case "photo_small":
      await run(["-f", "lavfi", "-i", scene(480, 320), "-frames:v", "1", "-q:v", "3", out]);
      break;
    case "clip_landscape":
      await run([
        "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=30:d=6,hue=h=${hue}`,
        "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
      ]);
      break;
    case "clip_portrait":
      await run([
        "-f", "lavfi", "-i", `testsrc2=s=1080x1920:r=30:d=5,hue=h=${hue}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", out,
      ]);
      break;
    case "music_120bpm":
      // Plucked tone on every beat (0.5 s period) plus a soft pad: a clean 120 BPM grid.
      await run([
        "-f", "lavfi", "-i",
        "aevalsrc=0.55*sin(2*PI*196*t)*exp(-9*mod(t\\,0.5))+0.12*sin(2*PI*98*t)|0.55*sin(2*PI*196*t)*exp(-9*mod(t\\,0.5))+0.12*sin(2*PI*147*t):s=44100:d=40",
        "-c:a", "libmp3lame", "-b:a", "192k", out,
      ]);
      break;
    case "corrupt_mp4": {
      const tmp = path.join(dir, `tmp_${name}`);
      await run(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", tmp]);
      const buf = fs.readFileSync(tmp);
      // Keep the ftyp header (passes signature sniffing) but destroy the rest.
      const bad = Buffer.concat([buf.subarray(0, 32), Buffer.alloc(4096, 0x5a)]);
      fs.writeFileSync(out, bad);
      fs.rmSync(tmp, { force: true });
      break;
    }
    case "fake_jpg":
      fs.writeFileSync(out, Buffer.from("#!/bin/sh\necho this is not an image\n".repeat(20)));
      break;
  }
  return out;
}
