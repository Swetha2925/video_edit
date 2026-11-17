import { route, json } from "@/server/http";
import { requireUserId } from "@/server/auth";
import { createProject, listProjects } from "@/server/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const userId = await requireUserId();
  return json({ projects: await listProjects(userId) });
});

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const project = await createProject(userId, body);
  return json({ project: { id: project.id } }, 201);
});
