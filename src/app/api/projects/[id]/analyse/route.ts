import { z } from "zod";
import { route, json, parseBody } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { enqueueJob } from "@/server/harness/jobs";
import { aiConfigured } from "@/server/agent/client";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const body = await parseBody(req, z.object({ force: z.boolean().default(false) }));
  if (!aiConfigured()) throw new AppError("AI_NOT_CONFIGURED", "AI vision analysis needs Claude. Add ANTHROPIC_API_KEY to .env — or use Basic assembly.");
  const job = await enqueueJob(id, "analyse", { force: body.force });
  return json({ job: { id: job.id } }, 202);
});
