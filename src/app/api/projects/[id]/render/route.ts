import { z } from "zod";
import { route, json, parseBody } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { enqueueJob } from "@/server/harness/jobs";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const body = await parseBody(req, z.object({ storyboardVersion: z.number().int().positive().optional() }));
  const sb = body.storyboardVersion
    ? await db.storyboard.findUnique({ where: { projectId_version: { projectId: id, version: body.storyboardVersion } } })
    : await db.storyboard.findFirst({ where: { projectId: id }, orderBy: { version: "desc" } });
  if (!sb) throw new AppError("BAD_REQUEST", "Create a plan before rendering.");
  const job = await enqueueJob(id, "render", { storyboardVersion: sb.version });
  return json({ job: { id: job.id } }, 202);
});
