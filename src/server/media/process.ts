import { spawn } from "node:child_process";
import { AppError } from "../errors";

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line (used for FFmpeg `-progress pipe:1`). */
  onStdoutLine?: (line: string) => void;
  /** Keep at most this many bytes of stderr (tail). */
  maxStderrBytes?: number;
  maxStdoutBytes?: number;
  cwd?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a media binary with an argument array (never a shell string), a hard timeout,
 * and cancellation support. Throws AppError on timeout / cancel / non-zero exit.
 */
export function runProcess(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const maxErr = opts.maxStderrBytes ?? 256 * 1024;
  const maxOut = opts.maxStdoutBytes ?? 32 * 1024 * 1024;
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AppError("CANCELLED", "Operation cancelled."));
    const child = spawn(bin, args, { shell: false, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let settled = false;
    let killedReason: "timeout" | "cancel" | undefined;

    const kill = (reason: "timeout" | "cancel") => {
      if (killedReason) return;
      killedReason = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = () => kill("cancel");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < maxOut) stdout += chunk;
      if (opts.onStdoutLine) {
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (line) {
            try {
              opts.onStdoutLine(line);
            } catch {
              /* progress callbacks must never crash the process runner */
            }
          }
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxErr * 2) stderr = stderr.slice(-maxErr);
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err) =>
      finish(() => reject(new AppError("TOOL_FAILED", `Could not start media tool: ${err.message}`, { cause: err }))),
    );
    child.on("close", (code) =>
      finish(() => {
        const durationMs = Date.now() - start;
        if (stderr.length > maxErr) stderr = stderr.slice(-maxErr);
        if (killedReason === "timeout")
          return reject(new AppError("TOOL_TIMEOUT", `Media tool timed out after ${Math.round(opts.timeoutMs / 1000)}s.`, { transient: true }));
        if (killedReason === "cancel") return reject(new AppError("CANCELLED", "Operation cancelled."));
        if (code !== 0) {
          return reject(
            new AppError("TOOL_FAILED", `Media tool exited with code ${code}.`, {
              details: { stderrTail: stderr.split("\n").filter(Boolean).slice(-12).join("\n") },
            }),
          );
        }
        resolve({ code: code ?? 0, stdout, stderr, durationMs });
      }),
    );
  });
}
