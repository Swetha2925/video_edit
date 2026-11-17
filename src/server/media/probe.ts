import fs from "node:fs";
import { z } from "zod";
import { AppError } from "../errors";
import { ffprobePath } from "./binaries";
import { runProcess } from "./process";

/** Raw ffprobe JSON (subset), validated before use. */
const ProbeStream = z.object({
  index: z.number(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  duration: z.string().optional(),
  nb_frames: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.record(z.string(), z.unknown())).optional(),
  disposition: z.record(z.string(), z.number()).optional(),
});
const ProbeOutput = z.object({
  streams: z.array(ProbeStream).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
      bit_rate: z.string().optional(),
    })
    .optional(),
});

export const MediaInfoSchema = z.object({
  formatName: z.string(),
  durationSec: z.number().nullable(),
  sizeBytes: z.number(),
  video: z
    .object({
      codec: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** Dimensions after applying rotation metadata (what viewers actually see). */
      displayWidth: z.number().int().positive(),
      displayHeight: z.number().int().positive(),
      rotation: z.number(),
      fps: z.number().nullable(),
      pixFmt: z.string().nullable(),
      isStillImage: z.boolean(),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number().nullable(),
      channels: z.number().nullable(),
      durationSec: z.number().nullable(),
    })
    .nullable(),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

const STILL_CODECS = new Set(["mjpeg", "png", "webp", "bmp", "tiff", "gif"]);

/** Read JPEG EXIF orientation (1-8) without external dependencies. Returns 1 when absent. */
export function readJpegOrientation(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) return 1;
    const marker = buf[off + 1] as number;
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") {
      const tiff = off + 10;
      const le = buf.toString("latin1", tiff, tiff + 2) === "II";
      const r16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const r32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + r32(tiff + 4);
      if (ifd + 2 > buf.length) return 1;
      const count = r16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > buf.length) return 1;
        if (r16(entry) === 0x0112) {
          const v = r16(entry + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda || len < 2) return 1; // start of scan: no more metadata
    off += 2 + len;
  }
  return 1;
}

function streamRotation(s: z.infer<typeof ProbeStream>): number {
  const tag = s.tags?.rotate;
  if (tag && Number.isFinite(Number(tag))) return ((Number(tag) % 360) + 360) % 360;
  for (const sd of s.side_data_list ?? []) {
    const r = sd["rotation"];
    if (typeof r === "number") return ((Math.round(-r) % 360) + 360) % 360;
  }
  return 0;
}

/** Inspect a media file with FFprobe and return validated, normalised metadata. */
export async function probeMedia(filePath: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MediaInfo> {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new AppError("CORRUPT_MEDIA", "The file is empty.");
  let res;
  try {
    res = await runProcess(
      ffprobePath(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal },
    );
  } catch (e) {
    if (e instanceof AppError && e.code === "TOOL_FAILED") {
      throw new AppError("CORRUPT_MEDIA", "The media file could not be read. It may be corrupted or use an unsupported codec.", { details: e.details });
    }
    throw e;
  }
  let parsed;
  try {
    parsed = ProbeOutput.parse(JSON.parse(res.stdout));
  } catch {
    throw new AppError("CORRUPT_MEDIA", "The media file metadata could not be parsed.");
  }
  const v = parsed.streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic === 1));
  const a = parsed.streams.find((s) => s.codec_type === "audio");
  const fmtDuration = parsed.format?.duration ? Number(parsed.format.duration) : NaN;

  let video: MediaInfo["video"] = null;
  if (v && v.width && v.height) {
    let rotation = streamRotation(v);
    const isStill = STILL_CODECS.has(v.codec_name ?? "") && /image2|_pipe|png|webp/.test(parsed.format?.format_name ?? "");
    if (isStill && v.codec_name === "mjpeg") {
      const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const o = readJpegOrientation(head);
      rotation = o >= 5 ? 90 : o === 3 || o === 4 ? 180 : 0;
    }
    const swap = rotation === 90 || rotation === 270;
    video = {
      codec: v.codec_name ?? "unknown",
      width: v.width,
      height: v.height,
      displayWidth: swap ? v.height : v.width,
      displayHeight: swap ? v.width : v.height,
      rotation,
      fps: isStill ? null : parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
      pixFmt: v.pix_fmt ?? null,
      isStillImage: isStill,
    };
  }
  const audio: MediaInfo["audio"] = a
    ? {
        codec: a.codec_name ?? "unknown",
        sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
        channels: a.channels ?? null,
        durationSec: a.duration ? Number(a.duration) : Number.isFinite(fmtDuration) ? fmtDuration : null,
      }
    : null;
  const durationSec = video?.isStillImage ? null : Number.isFinite(fmtDuration) ? fmtDuration : v?.duration ? Number(v.duration) : null;

  return MediaInfoSchema.parse({
    formatName: parsed.format?.format_name ?? "unknown",
    durationSec,
    sizeBytes: stat.size,
    video,
    audio,
  });
}

export function orientationOf(w: number, h: number): "portrait" | "landscape" | "square" {
  const r = w / h;
  if (r > 1.05) return "landscape";
  if (r < 0.95) return "portrait";
  return "square";
}
