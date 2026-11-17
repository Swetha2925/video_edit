import { z } from "zod";
import { route, json, parseBody } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { enqueueJob, activeJob } from "@/server/harness/jobs";
import { aiConfigured } from "@/server/agent/client";
import { AppError } from "@/server/errors";
import { db, newId } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const { message } = await parseBody(req, z.object({ message: z.string().trim().min(3, "Describe the change you want").max(2000) }));
  if (!aiConfigured()) throw new AppError("AI_NOT_CONFIGURED", "Natural-language revisions need Claude. Add ANTHROPIC_API_KEY to .env, or edit the storyboard directly.");
  if (!(await db.storyboard.count({ where: { projectId: id } }))) throw new AppError("BAD_REQUEST", "There is no plan to revise yet.");
  if (await activeJob(id)) throw new AppError("CONFLICT", "Please wait for the current task to finish.");
  const fb = await db.feedback.create({ data: { id: newId(), projectId: id, message } });
  const job = await enqueueJob(id, "revise", { feedbackId: fb.id });
  return json({ job: { id: job.id }, feedback: { id: fb.id } }, 202);
});
