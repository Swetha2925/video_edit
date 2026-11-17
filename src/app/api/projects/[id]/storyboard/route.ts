import { z } from "zod";
import { route, json, parseBody } from "@/server/http";
import { requireOwnedProject, requireUserId } from "@/server/auth";
import { StoryboardEditSchema } from "@/server/services/projects";
import { loadContext } from "@/server/harness/workflows";
import { validateStoryboard } from "@/server/render/storyboardValidation";
import { compileStoryboard } from "@/server/render/compiler";
import { validateEdl } from "@/server/render/edlValidation";
import { recordEvent } from "@/server/services/events";
import { activeJob } from "@/server/harness/jobs";
import { db, newId } from "@/server/db";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Save user edits (e.g. caption text) as a NEW storyboard version after validation. */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  if (await activeJob(id)) throw new AppError("CONFLICT", "Please wait for the current task to finish.");
  const body = await parseBody(req, StoryboardEditSchema);
  const base = await db.storyboard.findUnique({ where: { projectId_version: { projectId: id, version: body.baseVersion } } });
  if (!base) throw new AppError("NOT_FOUND", "Base storyboard version not found.");
  const { compile } = await loadContext(id);
  const sv = validateStoryboard(body.storyboard, compile);
  if (!sv.valid) throw new AppError("VALIDATION_FAILED", sv.errors[0] ?? "The storyboard is invalid.", { details: sv.errors });
  const { edl } = compileStoryboard(body.storyboard, compile);
  const ev = validateEdl(edl, compile, id);
  if (!ev.valid) throw new AppError("VALIDATION_FAILED", ev.errors[0] ?? "The edit could not be compiled.", { details: ev.errors });
  const agg = await db.storyboard.aggregate({ where: { projectId: id }, _max: { version: true } });
  const version = (agg._max.version ?? 0) + 1;
  await db.storyboard.create({
    data: { id: newId(), projectId: id, version, parentVersion: base.version, json: JSON.stringify(body.storyboard), source: "user_edit", note: ["Edited by you.", ...[...sv.warnings, ...ev.warnings].map((w) => `• ${w}`)].join("\n") },
  });
  await recordEvent(id, "storyboard_edited", `You edited the plan → storyboard v${version}.`, "info");
  return json({ version, warnings: [...sv.warnings, ...ev.warnings] });
});

/** Approve a storyboard version. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireOwnedProject(id, await requireUserId());
  const { version } = await parseBody(req, z.object({ version: z.number().int().positive() }));
  const sb = await db.storyboard.findUnique({ where: { projectId_version: { projectId: id, version } } });
  if (!sb) throw new AppError("NOT_FOUND", "Storyboard version not found.");
  await db.storyboard.update({ where: { id: sb.id }, data: { approved: true, approvedAt: new Date() } });
  await recordEvent(id, "storyboard_approved", `You approved storyboard v${version}.`, "success");
  return json({ ok: true });
});
