import { z } from "zod";
import { route, json, parseBody } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { enqueueJob } from "@/server/harness/jobs";
import { AppError } from "@/server/errors";
import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  // "smart" (alias "ai"): Claude when configured, otherwise the on-device creative engine.
  mode: z.enum(["smart", "ai", "basic"]).default("smart"),
  clarification: z.string().trim().max(1000).nullable().default(null),
  autoRender: z.boolean().default(false),
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const body = await parseBody(req, Body);
  const visuals = await db.asset.count({ where: { projectId: id, status: "ready", excluded: false, kind: { in: ["image", "video"] } } });
  if (visuals === 0) throw new AppError("BAD_REQUEST", "Upload at least one photo or video clip first.");
  const job = await enqueueJob(id, "plan", { ...body, mode: body.mode === "basic" ? "basic" : "ai" });
  return json({ job: { id: job.id } }, 202);
});
