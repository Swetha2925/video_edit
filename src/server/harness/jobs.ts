import type { Job } from "@prisma/client";
import { db, newId, parseJson } from "../db";
import { AppError, errorMessage, isAppError } from "../errors";
import { logger } from "../logger";
import { recordEvent } from "../services/events";

/**
 * Persistent background job queue (database-backed, survives restarts).
 *  - one active job per project (prevents conflicting edits/renders)
 *  - real progress written by the running tool (throttled), never simulated
 *  - cancellation via `cancelRequested`, propagated as an AbortSignal to FFmpeg/Claude
 *  - bounded retries for transient failures only; renders are not blindly retried
 *  - handlers may return `next` to chain a follow-up job (e.g. revise → render)
 */
export type JobType = "analyse" | "plan" | "render" | "revise";

export interface JobContext {
  job: Job;
  projectId: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  progress: (fraction: number, message: string) => void;
}

export interface JobResult {
  result?: unknown;
  next?: { type: JobType; payload: Record<string, unknown> };
}

type Handler = (ctx: JobContext) => Promise<JobResult | void>;

/**
 * Worker state lives on a process-wide singleton: Next.js may instantiate this module once
 * per route bundle, but there must be exactly one set of handlers / running jobs / timers.
 */
interface WorkerState {
  handlers: Map<JobType, Handler>;
  running: Map<string, AbortController>;
  ticking: boolean;
  started: boolean;
  timer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  failureHook?: (job: Job, cancelled: boolean, error: unknown) => Promise<void>;
}
// Stored on `process` (not globalThis): Next.js dev can evaluate route bundles in separate
// JS contexts, but they all share the real process object.
const G = process as unknown as { __reelcraftJobs?: WorkerState };
const state: WorkerState = (G.__reelcraftJobs ??= { handlers: new Map(), running: new Map(), ticking: false, started: false });
const handlers = state.handlers;
const MAX_ATTEMPTS: Record<JobType, number> = { analyse: 2, plan: 2, render: 1, revise: 2 };

export function registerHandler(type: JobType, h: Handler) {
  handlers.set(type, h);
}

export async function activeJob(projectId: string) {
  return db.job.findFirst({ where: { projectId, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } });
}

export async function enqueueJob(projectId: string, type: JobType, payload: Record<string, unknown> = {}): Promise<Job> {
  const existing = await activeJob(projectId);
  if (existing) throw new AppError("CONFLICT", `Please wait — a ${existing.type} task is already ${existing.status} for this project.`);
  const job = await db.job.create({
    data: { id: newId(), projectId, type, payloadJson: JSON.stringify(payload), maxAttempts: MAX_ATTEMPTS[type], message: "Waiting to start…" },
  });
  kick();
  return job;
}

export async function requestCancel(projectId: string, jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, projectId } });
  if (!job) throw new AppError("NOT_FOUND", "Task not found.");
  if (job.status === "queued") {
    await db.job.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date(), message: "Cancelled before it started." } });
    await recordEvent(projectId, "job_cancelled", `${job.type} task cancelled.`, "warning");
    return;
  }
  if (job.status === "running") await db.job.update({ where: { id: job.id }, data: { cancelRequested: true, message: "Cancelling…" } });
}

/* ---------------- worker ---------------- */

const running = state.running;
const CONCURRENCY = 2;

async function claimNext(): Promise<Job | null> {
  const candidates = await db.job.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, take: 5 });
  for (const c of candidates) {
    // Never run two jobs for the same project concurrently.
    if ([...running.keys()].length && (await db.job.count({ where: { projectId: c.projectId, status: "running" } })) > 0) continue;
    const claimed = await db.job.updateMany({
      where: { id: c.id, status: "queued" },
      data: { status: "running", startedAt: new Date(), heartbeatAt: new Date(), attempts: { increment: 1 }, message: "Starting…" },
    });
    if (claimed.count === 1) return db.job.findUnique({ where: { id: c.id } });
  }
  return null;
}

export async function executeJob(job: Job): Promise<void> {
  const handler = handlers.get(job.type as JobType);
  const controller = new AbortController();
  running.set(job.id, controller);
  let lastWrite = 0;
  let pending: { f: number; m: string } | null = null;
  const flush = async () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    lastWrite = Date.now();
    await db.job.update({ where: { id: job.id }, data: { progress: Math.max(0, Math.min(1, p.f)), message: p.m.slice(0, 300), heartbeatAt: new Date() } }).catch(() => undefined);
  };
  const ctx: JobContext = {
    job,
    projectId: job.projectId,
    payload: (parseJson(job.payloadJson) as Record<string, unknown>) ?? {},
    signal: controller.signal,
    progress: (f, m) => {
      pending = { f, m };
      if (Date.now() - lastWrite > 400) void flush();
    },
  };
  try {
    if (!handler) throw new AppError("INTERNAL", `No handler for job type ${job.type}`);
    const out = (await handler(ctx)) ?? {};
    await flush();
    await db.job.update({
      where: { id: job.id },
      data: { status: "succeeded", progress: 1, finishedAt: new Date(), resultJson: out.result === undefined ? null : JSON.stringify(out.result).slice(0, 50_000), message: "Done" },
    });
    if (out.next) {
      const nextJob = await db.job.create({
        data: { id: newId(), projectId: job.projectId, type: out.next.type, payloadJson: JSON.stringify(out.next.payload), maxAttempts: MAX_ATTEMPTS[out.next.type], message: "Waiting to start…" },
      });
      logger.info("job chained", { from: job.id, to: nextJob.id, type: nextJob.type });
    }
  } catch (e) {
    const cancelled = controller.signal.aborted || (isAppError(e) && e.code === "CANCELLED");
    const transient = isAppError(e) && e.transient;
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    const attempts = fresh?.attempts ?? job.attempts;
    if (!cancelled && transient && attempts < job.maxAttempts) {
      await db.job.update({ where: { id: job.id }, data: { status: "queued", message: `Retrying after a temporary problem: ${errorMessage(e)}`.slice(0, 300) } });
      await recordEvent(job.projectId, "job_retry", `Temporary problem during ${job.type}; retrying (attempt ${attempts + 1} of ${job.maxAttempts}).`, "warning");
    } else {
      await db.job.update({
        where: { id: job.id },
        data: {
          status: cancelled ? "cancelled" : "failed",
          finishedAt: new Date(),
          error: cancelled ? null : errorMessage(e).slice(0, 2000),
          message: cancelled ? "Cancelled" : "Failed",
        },
      });
      logger[cancelled ? "info" : "error"]("job ended", { jobId: job.id, type: job.type, cancelled, message: errorMessage(e), details: isAppError(e) ? e.details : undefined });
      await onJobFailed(job, cancelled, e);
    }
  } finally {
    running.delete(job.id);
  }
}

/** Hook set by workflows to put the project into a consistent stage after failure. */
export function setFailureHook(h: WorkerState["failureHook"]) {
  state.failureHook = h;
}
async function onJobFailed(job: Job, cancelled: boolean, error: unknown) {
  try {
    await state.failureHook?.(job, cancelled, error);
  } catch (e) {
    logger.error("failure hook error", { message: errorMessage(e) });
  }
}

async function tick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    while (running.size < CONCURRENCY) {
      const job = await claimNext();
      if (!job) break;
      void executeJob(job);
    }
  } catch (e) {
    logger.error("worker tick failed", { message: errorMessage(e) });
  } finally {
    state.ticking = false;
  }
}

async function checkCancellations() {
  if (running.size === 0) return;
  const ids = [...running.keys()];
  const flagged = await db.job.findMany({ where: { id: { in: ids }, cancelRequested: true }, select: { id: true } }).catch(() => []);
  for (const f of flagged) running.get(f.id)?.abort();
}

export function kick() {
  // Only the process that started the worker picks up jobs immediately; others rely on polling.
  if (state.started) void tick();
}

/** Process queued jobs until the queue is empty (used by tests, evals and scripts). */
export async function drainQueue(timeoutMs = 30 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await claimNext();
    if (!job) {
      if (running.size === 0) return;
      await new Promise((r) => setTimeout(r, 200));
    } else {
      await executeJob(job);
    }
    if (Date.now() > deadline) throw new Error("drainQueue timed out");
  }
}

const STALE_MS = 60_000;

/** Running jobs prove they are alive with a heartbeat every few seconds. */
async function heartbeat() {
  if (running.size === 0) return;
  await db.job.updateMany({ where: { id: { in: [...running.keys()] }, status: "running" }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
}

/**
 * Recover from a crash/restart: jobs whose heartbeat stopped are marked clearly as
 * interrupted, never left "running". Live jobs (recent heartbeat) are left alone.
 */
export async function recoverInterrupted() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await db.job.findMany({ where: { status: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }] } });
  for (const j of stale) {
    if (running.has(j.id)) continue;
    await db.job.update({ where: { id: j.id }, data: { status: "failed", finishedAt: new Date(), error: "Interrupted by a server restart.", message: "Interrupted" } });
    await onJobFailed(j, false, new AppError("INTERNAL", "Interrupted by a server restart."));
  }
  const live = await db.job.findMany({ where: { status: "running" }, select: { projectId: true } });
  await db.render.updateMany({
    where: { status: { in: ["queued", "rendering", "checking"] }, projectId: { notIn: live.map((l) => l.projectId) } },
    data: { status: "failed", error: "Interrupted by a server restart.", finishedAt: new Date() },
  });
}

export function startWorker() {
  if (state.started) return;
  state.started = true;
  void recoverInterrupted().then(() => kick());
  state.timer = setInterval(() => void tick(), 1000);
  state.cancelTimer = setInterval(() => void checkCancellations(), 1000);
  state.heartbeatTimer = setInterval(() => void heartbeat(), 5000);
  state.heartbeatTimer.unref?.();
  // Periodically sweep for jobs orphaned by a crashed process.
  setInterval(() => void recoverInterrupted(), STALE_MS).unref?.();
  state.timer.unref?.();
  state.cancelTimer.unref?.();
  logger.info("background worker started", { concurrency: CONCURRENCY, pid: process.pid });
}
