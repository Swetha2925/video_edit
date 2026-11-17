import { db, newId } from "../db";
import { assertTransition, type Stage } from "../harness/stateMachine";

/** Agent activity timeline shown in the UI ("Analysed 10 assets", "Render v3 passed QC", …). */
export async function recordEvent(projectId: string, kind: string, message: string, level: "info" | "success" | "warning" | "error" = "info", data?: unknown) {
  await db.projectEvent.create({
    data: { id: newId(), projectId, kind, message: message.slice(0, 1000), level, dataJson: data === undefined ? null : JSON.stringify(data).slice(0, 20_000) },
  });
}

/** Move the project through the workflow state machine (rejects illegal transitions). */
export async function setStage(projectId: string, to: Stage, message = "") {
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { stage: true } });
  assertTransition(p.stage, to);
  await db.project.update({ where: { id: projectId }, data: { stage: to, stageMessage: message.slice(0, 1000) } });
}
