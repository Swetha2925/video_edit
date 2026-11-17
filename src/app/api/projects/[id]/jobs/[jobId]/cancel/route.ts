import { route, json } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { requestCancel } from "@/server/harness/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; jobId: string }> };

export const POST = route(async (_req: Request, { params }: Ctx) => {
  const { id, jobId } = await params;
  await requireOwnedProject(id, await requireUserId());
  await requestCancel(id, jobId);
  return json({ ok: true });
});
