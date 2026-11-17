import { route } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { serveProjectFile } from "@/server/files";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; assetId: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id, assetId } = await params;
  await requireOwnedProject(id, await requireUserId());
  const asset = await db.asset.findFirst({ where: { id: assetId, projectId: id } });
  if (!asset) throw new AppError("NOT_FOUND", "File not found.");
  const url = new URL(req.url);
  // ?original=1 streams the original (images/audio previews); otherwise the thumbnail.
  if (url.searchParams.get("original") === "1") return serveProjectFile(req, id, `originals/${asset.storedName}`, { cacheSeconds: 3600 });
  if (!asset.thumbnailPath) throw new AppError("NOT_FOUND", "No thumbnail.");
  return serveProjectFile(req, id, asset.thumbnailPath, { cacheSeconds: 3600 });
});
