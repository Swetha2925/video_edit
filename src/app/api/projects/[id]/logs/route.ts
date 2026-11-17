import { route, json } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Observability: recent tool calls and model calls for this project. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const [toolCalls, modelCalls] = await Promise.all([
    db.toolCall.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 150 }),
    db.modelCall.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return json({ toolCalls, modelCalls });
});
