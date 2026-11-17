import { route, json } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { deleteAsset } from "@/server/services/assets";
import { AssetPatchSchema } from "@/server/services/projects";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { activeJob } from "@/server/harness/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; assetId: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id, assetId } = await params;
  await requireOwnedProject(id, await requireUserId());
  const patch = AssetPatchSchema.parse(await req.json());
  const asset = await db.asset.findFirst({ where: { id: assetId, projectId: id } });
  if (!asset) throw new AppError("NOT_FOUND", "File not found.");
  await db.asset.update({
    where: { id: asset.id },
    data: {
      ...(patch.excluded !== undefined ? { excluded: patch.excluded } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.license && asset.kind === "audio" ? { licenseJson: JSON.stringify(patch.license) } : {}),
    },
  });
  return json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id, assetId } = await params;
  await requireOwnedProject(id, await requireUserId());
  if (await activeJob(id)) throw new AppError("CONFLICT", "Please wait for the current task to finish.");
  await deleteAsset(id, assetId);
  return json({ deleted: true });
});
