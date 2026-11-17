import { route } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { serveProjectFile } from "@/server/files";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; path: string[] }> };

/** Review frames and contact sheets (only files under frames/). */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id, path } = await params;
  await requireOwnedProject(id, await requireUserId());
  if (!path.every((seg) => /^[a-zA-Z0-9._-]+$/.test(seg) && seg !== "..")) throw new AppError("FORBIDDEN", "Unsafe path.");
  return serveProjectFile(req, id, `frames/${path.join("/")}`, { cacheSeconds: 3600 });
});
