import { z, type ZodType } from "zod";
import { db, newId } from "../db";
import { AppError, errorMessage, isAppError } from "../errors";
import { logger } from "../logger";
import { assertSafeId } from "../storage";

/**
 * Tool registry. The orchestrator can only act through these narrow, typed tools —
 * never through arbitrary shell commands. Every invocation:
 *   1. validates input against the tool's Zod schema,
 *   2. checks it targets the current authorised project,
 *   3. runs under a timeout + cancellation signal,
 *   4. validates the output schema,
 *   5. writes a structured ToolCall log (timing, status, summaries — no media content).
 */
export interface ToolContext {
  projectId: string;
  jobId?: string;
  signal?: AbortSignal;
}

export interface ToolDef<I, O> {
  name: string;
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  timeoutMs: number;
  run: (input: I, ctx: ToolContext & { signal: AbortSignal }) => Promise<O>;
  summarize?: (input: I, output?: O) => { input?: string; output?: string };
}

const registry = new Map<string, ToolDef<unknown, unknown>>();

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (registry.has(def.name)) return registry.get(def.name) as unknown as ToolDef<I, O>;
  registry.set(def.name, def as unknown as ToolDef<unknown, unknown>);
  return def;
}

export function listTools(): { name: string; description: string; timeoutMs: number }[] {
  return [...registry.values()].map((t) => ({ name: t.name, description: t.description, timeoutMs: t.timeoutMs }));
}

export async function runTool<I, O>(tool: ToolDef<I, O>, rawInput: unknown, ctx: ToolContext): Promise<O> {
  assertSafeId(ctx.projectId, "project id");
  const started = Date.now();
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    await log(tool.name, ctx, "error", Date.now() - started, "invalid input", "", "");
    throw new AppError("VALIDATION_FAILED", `Invalid input for tool ${tool.name}.`, { details: parsed.error.issues.slice(0, 10) });
  }
  const input = parsed.data;
  // Permission: tools may only act on the project they were invoked for.
  const maybeProject = (input as { projectId?: unknown })?.projectId;
  if (typeof maybeProject === "string" && maybeProject !== ctx.projectId) {
    await log(tool.name, ctx, "error", Date.now() - started, "permission denied", "", "");
    throw new AppError("FORBIDDEN", `Tool ${tool.name} attempted to access another project.`);
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (ctx.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, tool.timeoutMs);
  const summary = tool.summarize?.(input);
  try {
    const out = await tool.run(input, { ...ctx, signal: controller.signal });
    const checked = tool.output.safeParse(out);
    if (!checked.success) throw new AppError("TOOL_FAILED", `Tool ${tool.name} produced invalid output.`, { details: checked.error.issues.slice(0, 5) });
    const s2 = tool.summarize?.(input, checked.data);
    await log(tool.name, ctx, "ok", Date.now() - started, null, s2?.input ?? summary?.input ?? "", s2?.output ?? "");
    return checked.data;
  } catch (e) {
    const status = timedOut ? "timeout" : isAppError(e) && e.code === "CANCELLED" ? "cancelled" : "error";
    await log(tool.name, ctx, status, Date.now() - started, errorMessage(e), summary?.input ?? "", "");
    if (timedOut) throw new AppError("TOOL_TIMEOUT", `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)}s.`, { transient: true, cause: e });
    if (ctx.signal?.aborted) throw new AppError("CANCELLED", "Operation cancelled.");
    throw e;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
}

async function log(tool: string, ctx: ToolContext, status: string, durationMs: number, error: string | null, inputSummary: string, outputSummary: string) {
  try {
    await db.toolCall.create({
      data: { id: newId(), projectId: ctx.projectId, jobId: ctx.jobId ?? null, tool, status, durationMs, error: error?.slice(0, 1000) ?? null, inputSummary: inputSummary.slice(0, 500), outputSummary: outputSummary.slice(0, 500) },
    });
  } catch (e) {
    logger.warn("tool log failed", { tool, message: errorMessage(e) });
  }
  logger.info("tool", { tool, projectId: ctx.projectId, jobId: ctx.jobId, status, durationMs, error });
}

export const ProjectRef = z.object({ projectId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/) });
