import fs from "node:fs";
import { Readable } from "node:stream";
import { AppError } from "./errors";
import { resolveProjectPath } from "./storage";

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", json: "application/json" };

/**
 * Serve a project file (after the caller has verified ownership) with HTTP Range support
 * so the browser video player can seek. Paths are resolved through the storage guard.
 */
export function serveProjectFile(req: Request, projectId: string, rel: string, opts: { downloadName?: string; cacheSeconds?: number } = {}): Response {
  const abs = resolveProjectPath(projectId, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new AppError("NOT_FOUND", "File not found.");
  const size = fs.statSync(abs).size;
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  const headers = new Headers({
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": `private, max-age=${opts.cacheSeconds ?? 0}`,
    "X-Content-Type-Options": "nosniff",
  });
  if (opts.downloadName) headers.set("Content-Disposition", `attachment; filename="${opts.downloadName.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : NaN;
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end);
      end = size - 1;
    } else if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, { status: 200, headers });
}
