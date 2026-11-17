import { route } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { serveProjectFile } from "@/server/files";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; version: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id, version } = await params;
  const project = await requireOwnedProject(id, await requireUserId());
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) throw new AppError("BAD_REQUEST", "Invalid version.");
  const render = await db.render.findUnique({ where: { projectId_version: { projectId: id, version: v } } });
  if (!render || !render.outputPath) throw new AppError("NOT_FOUND", "Render not found.");
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && render.status !== "passed") throw new AppError("CONFLICT", "Only renders that passed quality checks can be exported.");
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "reel";
  return serveProjectFile(req, id, render.outputPath, { downloadName: download ? `${slug}-v${v}-${render.width}x${render.height}.mp4` : undefined });
});
