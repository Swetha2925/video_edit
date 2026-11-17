import { route, json } from "@/server/http";
import { getConfig } from "@/server/config";
import { getMediaCapabilities } from "@/server/media/binaries";
import { aiConfigured } from "@/server/agent/client";
import { listTools } from "@/server/harness/registry";
import { ACCEPT_ATTRIBUTE } from "@/server/media/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health + capability report (never includes secret values). */
export const GET = route(async () => {
  const cfg = getConfig();
  let media: Awaited<ReturnType<typeof getMediaCapabilities>> | null = null;
  let mediaError: string | null = null;
  try {
    media = await getMediaCapabilities();
  } catch (e) {
    mediaError = e instanceof Error ? e.message : String(e);
  }
  return json({
    appName: cfg.appName,
    ai: { configured: aiConfigured(), model: cfg.anthropic.model, effort: cfg.anthropic.effort },
    media: media
      ? { ok: media.ok, ffmpegVersion: media.ffmpegVersion, ffprobeVersion: media.ffprobeVersion, missingFilters: media.missingFilters, hasLibx264: media.hasLibx264 }
      : { ok: false, error: mediaError },
    limits: cfg.limits,
    accept: ACCEPT_ATTRIBUTE,
    tools: listTools(),
  });
});
