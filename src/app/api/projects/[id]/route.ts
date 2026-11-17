import { route, json } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { deleteProject, projectDetail, updateProject } from "@/server/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  return json(await projectDetail(id));
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  await updateProject(id, await req.json());
  return json(await projectDetail(id));
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  await deleteProject(id);
  return json({ deleted: true });
});
