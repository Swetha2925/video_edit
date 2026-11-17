import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ZodType } from "zod";
import { getConfig } from "../config";
import { db, newId } from "../db";
import { AppError } from "../errors";
import { logger } from "../logger";

/**
 * The only place the app talks to Claude. Responsibilities:
 *  - server-side API key only (never sent to the browser)
 *  - per-project model-call budget
 *  - structured JSON output constrained by a Zod-derived JSON schema
 *  - refusal / truncation / invalid-output handling
 *  - usage + latency logging for observability and cost tracking
 *
 * Refusal fallbacks: requests opt into the server-side fallback chain
 * ("server-side-fallback-2026-07-01", fallbacks: "default") so a safety-classifier
 * decline is retried on a fallback model inside the same call.
 */

let client: Anthropic | undefined;

export function aiConfigured(): boolean {
  return Boolean(getConfig().anthropic.apiKey);
}

export function getClient(): Anthropic {
  const key = getConfig().anthropic.apiKey;
  if (!key) throw new AppError("AI_NOT_CONFIGURED", "Claude is not configured. Add ANTHROPIC_API_KEY to .env to enable AI planning.");
  if (!client) client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 });
  return client;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredCall<T> {
  projectId: string;
  purpose: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  /** Parsed JSON (validated only against the JSON shape; callers apply strict domain validation). */
  data: unknown;
  raw: string;
  /** Assistant content to append if a follow-up (repair) turn is needed. */
  assistantContent: Anthropic.Beta.BetaContentBlockParam[];
  usage: { inputTokens: number; outputTokens: number };
  typed?: T;
}

async function assertBudget(projectId: string) {
  const used = await db.modelCall.count({ where: { projectId } });
  const max = getConfig().limits.maxModelCallsPerProject;
  if (used >= max) throw new AppError("LIMIT_EXCEEDED", `This project has reached its limit of ${max} AI calls. Raise MAX_MODEL_CALLS_PER_PROJECT to continue.`);
}

async function logCall(entry: {
  projectId: string;
  purpose: string;
  model: string;
  status: string;
  durationMs: number;
  usage?: Anthropic.Beta.BetaUsage;
  stopReason?: string | null;
  error?: string;
}) {
  try {
    await db.modelCall.create({
      data: {
        id: newId(),
        projectId: entry.projectId,
        purpose: entry.purpose,
        model: entry.model,
        status: entry.status,
        durationMs: entry.durationMs,
        inputTokens: entry.usage?.input_tokens ?? 0,
        outputTokens: entry.usage?.output_tokens ?? 0,
        cacheReadTokens: entry.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: entry.usage?.cache_creation_input_tokens ?? 0,
        stopReason: entry.stopReason ?? null,
        error: entry.error?.slice(0, 1000) ?? null,
      },
    });
  } catch (e) {
    logger.warn("failed to log model call", { message: e instanceof Error ? e.message : String(e) });
  }
}

export async function callStructured<T>(req: StructuredCall<T>): Promise<StructuredResult<T>> {
  await assertBudget(req.projectId);
  const cfg = getConfig();
  const model = cfg.anthropic.model;
  const started = Date.now();
  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = getClient().beta.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort ?? cfg.anthropic.effort, format: betaZodOutputFormat(req.schema as never) },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
      },
      { signal: req.signal },
    );
    message = await stream.finalMessage();
  } catch (e) {
    const durationMs = Date.now() - started;
    if (req.signal?.aborted) throw new AppError("CANCELLED", "Operation cancelled.");
    let transient = false;
    let msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Anthropic.AuthenticationError) msg = "Claude rejected the API key. Check ANTHROPIC_API_KEY.";
    else if (e instanceof Anthropic.PermissionDeniedError) msg = "This API key does not have access to the configured model.";
    else if (e instanceof Anthropic.NotFoundError) msg = `Model "${model}" was not found. Check ANTHROPIC_MODEL.`;
    else if (e instanceof Anthropic.RateLimitError) {
      msg = "Claude rate limit reached; the step will be retried.";
      transient = true;
    } else if (e instanceof Anthropic.BadRequestError) msg = `Claude rejected the request: ${msg}`;
    else if (e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) transient = true;
    await logCall({ projectId: req.projectId, purpose: req.purpose, model, status: "error", durationMs, error: msg });
    throw new AppError("AI_FAILED", msg, { transient, cause: e });
  }
  const durationMs = Date.now() - started;
  const usage = message.usage;
  if (message.stop_reason === "refusal") {
    await logCall({ projectId: req.projectId, purpose: req.purpose, model: message.model, status: "refusal", durationMs, usage, stopReason: message.stop_reason });
    throw new AppError("AI_FAILED", "Claude declined this request. Try rephrasing the prompt or removing sensitive content.");
  }
  if (message.stop_reason === "max_tokens") {
    await logCall({ projectId: req.projectId, purpose: req.purpose, model: message.model, status: "invalid_output", durationMs, usage, stopReason: message.stop_reason });
    throw new AppError("AI_FAILED", "Claude's response was cut off before it finished.", { transient: true });
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    await logCall({ projectId: req.projectId, purpose: req.purpose, model: message.model, status: "invalid_output", durationMs, usage, stopReason: message.stop_reason, error: "non-JSON output" });
    throw new AppError("AI_FAILED", "Claude returned output that was not valid JSON.", { transient: true });
  }
  await logCall({ projectId: req.projectId, purpose: req.purpose, model: message.model, status: "ok", durationMs, usage, stopReason: message.stop_reason });
  const typed = req.schema.safeParse(data);
  return {
    data,
    raw: text,
    // Pass the full content back unchanged (thinking blocks included) for repair turns.
    assistantContent: message.content as unknown as Anthropic.Beta.BetaContentBlockParam[],
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    typed: typed.success ? typed.data : undefined,
  };
}

/** Build an image content block from a JPEG buffer. */
export function jpegBlock(buf: Buffer): Anthropic.Beta.BetaImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
}
