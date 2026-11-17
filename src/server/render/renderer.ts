import fs from "node:fs";
import path from "node:path";
import type { Edl } from "@/lib/schemas";
import { getConfig } from "../config";
import { AppError } from "../errors";
import { ffmpegPath } from "../media/binaries";
import { runProcess } from "../media/process";
import { resolveProjectPath } from "../storage";
import { buildAssScript } from "./ass";
import { finalStep, loudnessStep, parseLoudnorm, segmentStep, type FfmpegStep, type PlanPaths } from "./ffmpegPlan";

export interface RenderProgress {
  fraction: number; // 0..1 — derived from FFmpeg's real out_time
  message: string;
}

export interface RenderOutcome {
  /** Project-relative path of the finished file (renders/vN.mp4). */
  outputRel: string;
  renderMs: number;
  loudnessMeasured: boolean;
}

/**
 * Execute an EDL render. Output is written to a temp file and atomically renamed to
 * `renders/v<version>.mp4` only after FFmpeg exits successfully — previous renders are
 * never overwritten and a half-written file never appears under the final name.
 */
export async function renderEdl(
  projectId: string,
  edl: Edl,
  version: number,
  opts: { signal?: AbortSignal; onProgress?: (p: RenderProgress) => void; workName: string },
): Promise<RenderOutcome> {
  const started = Date.now();
  const cfg = getConfig();
  const workDir = resolveProjectPath(projectId, `work/${opts.workName}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const outputRel = `renders/v${version}.mp4`;
  const finalAbs = resolveProjectPath(projectId, outputRel);
  if (fs.existsSync(finalAbs)) throw new AppError("CONFLICT", `Render v${version} already exists; refusing to overwrite.`);
  fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
  const tempOut = path.join(workDir, "output.partial.mp4");

  // Fonts are exposed to libass via a relative directory inside the work dir.
  const fontsLink = path.join(workDir, "fonts");
  try {
    fs.symlinkSync(cfg.fontsDir, fontsLink, "dir");
  } catch {
    fs.cpSync(cfg.fontsDir, fontsLink, { recursive: true });
  }
  let assRel: string | null = null;
  if (edl.texts.length > 0) {
    fs.writeFileSync(path.join(workDir, "text.ass"), buildAssScript(edl), "utf8");
    assRel = "text.ass";
  }

  const paths: PlanPaths = {
    resolve: (rel) => resolveProjectPath(projectId, rel),
    workDir,
    segmentPath: (i) => path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`),
    outputPath: tempOut,
    assRel,
    fontsRel: "fonts",
  };

  const steps: FfmpegStep[] = edl.clips.map((_, i) => segmentStep(edl, i, paths));
  const ln = loudnessStep(edl, paths);
  if (ln) steps.push(ln);
  const totalWeight = steps.reduce((s, st) => s + st.weight * Math.max(0.5, st.durationSec), 0) + 2 * (edl.output.totalFrames / edl.output.fps);
  let doneWeight = 0;
  const deadline = started + cfg.render.timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new AppError("TOOL_TIMEOUT", "Render exceeded the configured time limit.", { transient: false });
    return ms;
  };

  const runStep = async (step: FfmpegStep, w: number) => {
    opts.onProgress?.({ fraction: doneWeight / totalWeight, message: step.label });
    const res = await runProcess(ffmpegPath(), step.args, {
      timeoutMs: remaining(),
      signal: opts.signal,
      cwd: workDir,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && step.durationSec > 0) {
          const sec = Number(m[1]) / 1_000_000;
          const frac = Math.min(1, Math.max(0, sec / step.durationSec));
          opts.onProgress?.({ fraction: (doneWeight + frac * w) / totalWeight, message: step.label });
        }
      },
    });
    doneWeight += w;
    return res;
  };

  for (const step of steps.filter((s) => s.kind === "segment")) {
    await runStep(step, step.weight * Math.max(0.5, step.durationSec));
  }
  let measured = null;
  if (ln) {
    const res = await runStep(ln, ln.weight * Math.max(0.5, ln.durationSec));
    measured = parseLoudnorm(res.stderr);
  }
  const fin = finalStep(edl, paths, measured);
  await runStep(fin, 2 * fin.durationSec);

  if (!fs.existsSync(tempOut) || fs.statSync(tempOut).size === 0) throw new AppError("RENDER_FAILED", "FFmpeg finished but produced no output file.");
  fs.renameSync(tempOut, finalAbs);
  opts.onProgress?.({ fraction: 1, message: "Render complete" });
  return { outputRel, renderMs: Date.now() - started, loudnessMeasured: measured !== null };
}
