import { route, json } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { ingestUpload, LicenseSchema } from "@/server/services/assets";
import { AppError } from "@/server/errors";
import { activeJob } from "@/server/harness/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Streaming single-file upload. The client sends the raw file body with
 * `X-File-Name` (URI-encoded) and optional `X-License` (URI-encoded JSON for music).
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  if (await activeJob(id)) throw new AppError("CONFLICT", "Please wait for the current task to finish before adding files.");
  const rawName = req.headers.get("x-file-name");
  if (!rawName) throw new AppError("BAD_REQUEST", "Missing file name.");
  let fileName: string;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid file name.");
  }
  let license;
  const rawLicense = req.headers.get("x-license");
  if (rawLicense) {
    try {
      license = LicenseSchema.parse(JSON.parse(decodeURIComponent(rawLicense)));
    } catch {
      throw new AppError("BAD_REQUEST", "Invalid licence information.");
    }
  }
  const asset = await ingestUpload({ projectId: id, fileName, body: req.body, license });
  return json({ asset: { id: asset.id, kind: asset.kind, originalName: asset.originalName } }, 201);
});
