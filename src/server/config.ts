import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

/**
 * Central, validated server configuration. Every limit the app enforces lives here
 * so it can be tuned from the environment without code changes.
 */
const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  NEXT_PUBLIC_APP_NAME: z.string().optional().default("ReelCraft AI"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional().transform((v) => (v && v.trim()) || "claude-opus-5-5"),
  ANTHROPIC_EFFORT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim()) || "high")
    .pipe(z.enum(["low", "medium", "high", "xhigh", "max"])),
  SESSION_SECRET: z.string().optional(),
  STORAGE_ROOT: z.string().optional().transform((v) => (v && v.trim()) || "./storage"),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  MAX_IMAGE_BYTES: intFromEnv(40 * 1024 * 1024),
  MAX_VIDEO_BYTES: intFromEnv(1024 * 1024 * 1024),
  MAX_AUDIO_BYTES: intFromEnv(100 * 1024 * 1024),
  MAX_VIDEO_DURATION_SEC: intFromEnv(600),
  MAX_ASSETS_PER_PROJECT: intFromEnv(60),
  MAX_OUTPUT_DURATION_SEC: intFromEnv(180),
  MAX_RENDERS_PER_PROJECT: intFromEnv(40),
  MAX_MODEL_CALLS_PER_PROJECT: intFromEnv(150),
  AUTO_FIX_RENDER_BUDGET: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? 2 : Number(v)))
    .pipe(z.number().int().min(0).max(5)),
  RENDER_CRF: intFromEnv(18).pipe(z.number().max(35)),
  RENDER_PRESET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim()) || "medium")
    .pipe(z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"])),
  RENDER_TIMEOUT_SEC: intFromEnv(1800),
});

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig() {
  const env = EnvSchema.parse(process.env);
  const storageRoot = path.resolve(process.cwd(), env.STORAGE_ROOT);
  return {
    appName: env.NEXT_PUBLIC_APP_NAME,
    isProd: env.NODE_ENV === "production",
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() ? env.ANTHROPIC_API_KEY.trim() : undefined,
      model: env.ANTHROPIC_MODEL,
      effort: env.ANTHROPIC_EFFORT,
    },
    sessionSecret: env.SESSION_SECRET,
    storageRoot,
    fontsDir: path.resolve(process.cwd(), "assets/fonts"),
    binaries: { ffmpeg: env.FFMPEG_PATH?.trim() || undefined, ffprobe: env.FFPROBE_PATH?.trim() || undefined },
    limits: {
      maxImageBytes: env.MAX_IMAGE_BYTES,
      maxVideoBytes: env.MAX_VIDEO_BYTES,
      maxAudioBytes: env.MAX_AUDIO_BYTES,
      maxVideoDurationSec: env.MAX_VIDEO_DURATION_SEC,
      maxAssetsPerProject: env.MAX_ASSETS_PER_PROJECT,
      maxOutputDurationSec: env.MAX_OUTPUT_DURATION_SEC,
      maxRendersPerProject: env.MAX_RENDERS_PER_PROJECT,
      maxModelCallsPerProject: env.MAX_MODEL_CALLS_PER_PROJECT,
      autoFixRenderBudget: env.AUTO_FIX_RENDER_BUDGET,
    },
    render: { crf: env.RENDER_CRF, preset: env.RENDER_PRESET, timeoutMs: env.RENDER_TIMEOUT_SEC * 1000 },
  };
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig();
  return cached;
}

/** Testing hook: rebuild config after mutating process.env. */
export function resetConfigForTests(): void {
  cached = undefined;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
