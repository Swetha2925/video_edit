import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Asset } from "@prisma/client";
import { z } from "zod";
import { AssetAnalysisSchema } from "@/lib/schemas";
import { getConfig } from "../config";
import { db, newId, parseJson } from "../db";
import { AppError } from "../errors";
import { AudioAnalysisSchema, type AudioAnalysis } from "../media/audio";
import { VisualMetricsSchema, type VisualMetrics } from "../media/derive";
import { orientationOf } from "../media/probe";
import { checkSignature, EXTENSION_FAMILY, extensionOf, SUPPORTED_FORMATS } from "../media/signature";
import { ensureProjectDirs, resolveProjectPath, sanitizeDisplayName } from "../storage";
import { runTool } from "../harness/registry";
import { analyseAudioTool, generateThumbnailTool, inspectMediaTool, measureVisualQualityTool } from "../harness/tools";
import type { AgentAsset } from "../agent/context";
import type { PlanAsset } from "../render/types";
import { recordEvent } from "./events";

export const LicenseSchema = z.object({
  source: z.string().trim().max(300).default(""),
  license: z.string().trim().max(300).default(""),
  attribution: z.string().trim().max(300).default(""),
});

function kindFromExtension(ext: string): "image" | "video" | "audio" | null {
  const fam = EXTENSION_FAMILY[ext];
  if (!fam) return null;
  const k = SUPPORTED_FORMATS[fam[0] as string]?.kind;
  return k ?? null;
}

/**
 * Streaming upload with enforced byte limits, signature validation, FFprobe validation,
 * thumbnail + metrics generation. Invalid files are deleted and never recorded as assets.
 */
export async function ingestUpload(opts: {
  projectId: string;
  fileName: string;
  body: ReadableStream<Uint8Array> | null;
  license?: z.infer<typeof LicenseSchema>;
}): Promise<Asset> {
  const cfg = getConfig();
  if (!opts.body) throw new AppError("BAD_REQUEST", "No file data received.");
  const displayName = sanitizeDisplayName(opts.fileName);
  const ext = extensionOf(displayName);
  const guessedKind = kindFromExtension(ext);
  if (!guessedKind) throw new AppError("UNSUPPORTED_MEDIA", `".${ext || "?"}" files are not supported. Use JPEG, PNG, WebP, MP4, MOV, MP3, M4A, WAV or AAC.`);
  const count = await db.asset.count({ where: { projectId: opts.projectId } });
  if (count >= cfg.limits.maxAssetsPerProject) throw new AppError("LIMIT_EXCEEDED", `A project can hold at most ${cfg.limits.maxAssetsPerProject} files.`);

  const maxBytes = guessedKind === "image" ? cfg.limits.maxImageBytes : guessedKind === "video" ? cfg.limits.maxVideoBytes : cfg.limits.maxAudioBytes;
  ensureProjectDirs(opts.projectId);
  const id = newId();
  const partRel = `work/upload_${id}.part`;
  const partAbs = resolveProjectPath(opts.projectId, partRel);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > maxBytes) cb(new AppError("PAYLOAD_TOO_LARGE", `File is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit for ${guessedKind} files.`));
      else cb(null, chunk);
    },
  });
  let storedAbs: string | null = null;
  try {
    await pipeline(Readable.fromWeb(opts.body as unknown as import("node:stream/web").ReadableStream), limiter, fs.createWriteStream(partAbs, { mode: 0o640 }));
    if (received === 0) throw new AppError("BAD_REQUEST", "The file is empty.");
    const head = Buffer.alloc(64);
    const fd = fs.openSync(partAbs, "r");
    try {
      fs.readSync(fd, head, 0, 64, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sig = checkSignature(displayName, head);
    if (!sig.ok) throw new AppError("UNSUPPORTED_MEDIA", sig.reason);
    const storedName = `${id}.${sig.format.ext}`;
    const rel = `originals/${storedName}`;
    storedAbs = resolveProjectPath(opts.projectId, rel);
    fs.renameSync(partAbs, storedAbs);
    fs.chmodSync(storedAbs, 0o440); // originals are read-only: never modified

    const info = await runTool(inspectMediaTool, { projectId: opts.projectId, assetId: id, rel }, { projectId: opts.projectId });
    let kind: "image" | "video" | "audio" = sig.format.kind;
    if (kind === "video" && !info.video && info.audio && (ext === "m4a" || ext === "mp4")) kind = "audio";
    if (kind === "image") {
      if (!info.video || !info.video.isStillImage) throw new AppError("CORRUPT_MEDIA", "This image could not be decoded (animated or corrupted images are not supported).");
    } else if (kind === "video") {
      if (!info.video || info.video.isStillImage) throw new AppError("CORRUPT_MEDIA", "No readable video stream was found in this file.");
      if (!info.durationSec || info.durationSec < 0.3) throw new AppError("CORRUPT_MEDIA", "The video is too short or its duration could not be read.");
      if (info.durationSec > cfg.limits.maxVideoDurationSec) throw new AppError("LIMIT_EXCEEDED", `Videos can be at most ${cfg.limits.maxVideoDurationSec / 60} minutes long.`);
    } else {
      if (!info.audio) throw new AppError("CORRUPT_MEDIA", "No readable audio stream was found in this file.");
      if (!info.durationSec || info.durationSec < 1) throw new AppError("CORRUPT_MEDIA", "The audio is too short or its duration could not be read.");
    }
    const mime = kind === "audio" && sig.format.kind !== "audio" ? "audio/mp4" : sig.format.mime;
    const w = info.video?.displayWidth ?? null;
    const h = info.video?.displayHeight ?? null;

    let thumbnailRel: string | null = null;
    let metrics: VisualMetrics | AudioAnalysis | null = null;
    if (kind === "image" || kind === "video") {
      const dur = kind === "video" ? info.durationSec : null;
      thumbnailRel = (await runTool(generateThumbnailTool, { projectId: opts.projectId, assetId: id, rel, kind, durationSec: dur }, { projectId: opts.projectId })).thumbnailRel;
      metrics = await runTool(measureVisualQualityTool, { projectId: opts.projectId, assetId: id, rel, kind, durationSec: dur }, { projectId: opts.projectId });
    } else {
      metrics = await runTool(analyseAudioTool, { projectId: opts.projectId, assetId: id, rel }, { projectId: opts.projectId });
    }
    const asset = await db.asset.create({
      data: {
        id,
        projectId: opts.projectId,
        kind,
        originalName: displayName,
        storedName,
        mimeType: mime,
        sizeBytes: received,
        durationSec: kind === "image" ? null : info.durationSec,
        width: w,
        height: h,
        orientation: w && h ? orientationOf(w, h) : null,
        fps: info.video?.fps ?? null,
        hasAudio: info.audio !== null,
        codec: kind === "audio" ? info.audio?.codec ?? null : info.video?.codec ?? null,
        thumbnailPath: thumbnailRel,
        status: "ready",
        sortOrder: count,
        metricsJson: JSON.stringify(metrics),
        licenseJson: kind === "audio" && opts.license ? JSON.stringify(opts.license) : null,
      },
    });
    await recordEvent(opts.projectId, "asset_uploaded", `Added ${kind} "${displayName}"${w && h ? ` (${w}×${h})` : ""}${asset.durationSec ? `, ${asset.durationSec.toFixed(1)}s` : ""}.`, "info");
    return asset;
  } catch (e) {
    fs.rmSync(partAbs, { force: true });
    if (storedAbs) {
      try {
        fs.chmodSync(storedAbs, 0o640);
      } catch {
        /* ignore */
      }
      fs.rmSync(storedAbs, { force: true });
    }
    fs.rmSync(resolveProjectPath(opts.projectId, `thumbs/${id}.jpg`), { force: true });
    throw e;
  }
}

export async function deleteAsset(projectId: string, assetId: string) {
  const a = await db.asset.findFirst({ where: { id: assetId, projectId } });
  if (!a) throw new AppError("NOT_FOUND", "File not found.");
  for (const rel of [`originals/${a.storedName}`, a.thumbnailPath].filter(Boolean) as string[]) {
    const abs = resolveProjectPath(projectId, rel);
    try {
      fs.chmodSync(abs, 0o640);
    } catch {
      /* missing */
    }
    fs.rmSync(abs, { force: true });
  }
  await db.asset.delete({ where: { id: a.id } });
}

/* ---------- typed views of stored assets ---------- */

export function assetMetrics(a: Asset): VisualMetrics | undefined {
  if (a.kind === "audio") return undefined;
  const r = VisualMetricsSchema.safeParse(parseJson(a.metricsJson));
  return r.success ? r.data : undefined;
}
export function assetAudio(a: Asset): AudioAnalysis | undefined {
  if (a.kind !== "audio") return undefined;
  const r = AudioAnalysisSchema.safeParse(parseJson(a.metricsJson));
  return r.success ? r.data : undefined;
}
export function assetAnalysis(a: Asset) {
  const r = AssetAnalysisSchema.safeParse(parseJson(a.analysisJson));
  return r.success ? r.data : undefined;
}

export function toAgentAsset(a: Asset): AgentAsset {
  const lic = LicenseSchema.safeParse(parseJson(a.licenseJson));
  return {
    id: a.id,
    kind: a.kind as AgentAsset["kind"],
    originalName: a.originalName,
    width: a.width,
    height: a.height,
    durationSec: a.durationSec,
    hasAudio: a.hasAudio,
    excluded: a.excluded,
    metrics: assetMetrics(a),
    audio: assetAudio(a),
    analysis: assetAnalysis(a),
    license: lic.success ? lic.data : undefined,
  };
}

export function toPlanAsset(a: Asset): PlanAsset {
  const m = assetMetrics(a);
  const au = assetAudio(a);
  const an = assetAnalysis(a);
  return {
    id: a.id,
    kind: a.kind as PlanAsset["kind"],
    storedName: a.storedName,
    originalName: a.originalName,
    width: a.width,
    height: a.height,
    durationSec: a.durationSec,
    hasAudio: a.hasAudio,
    excluded: a.excluded,
    status: a.status,
    brightness: m?.brightness,
    blur: m?.blur,
    focalPoint: an?.focalPoint,
    beats: au?.beats,
    bpm: au?.bpm ?? null,
  };
}

export async function loadProjectAssets(projectId: string) {
  return db.asset.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

export const VISION_FILE_DIR = (projectId: string) => path.dirname(resolveProjectPath(projectId, "frames/vision/x.jpg"));
