import { SceneSchema, type RevisionOp, type Storyboard } from "@/lib/schemas";
import { normalizeDurations } from "../render/storyboardValidation";

/**
 * Apply revision operations to a storyboard deterministically. Scenes not targeted by
 * an operation are carried over unchanged (same object values), which is what makes
 * "change only the opening" verifiable.
 */
export interface ApplyResult {
  storyboard: Storyboard;
  errors: string[];
  changedSceneIds: string[];
}

export function applyRevisionOps(sb: Storyboard, ops: RevisionOp[], targetDuration: number): ApplyResult {
  const errors: string[] = [];
  const changed = new Set<string>();
  let scenes = sb.scenes.map((s) => ({ ...s }));
  let next: Storyboard = { ...sb };
  let newTotal: number | null = null;
  const indexOf = (id: string) => scenes.findIndex((s) => s.id === id);

  for (const [i, op] of ops.entries()) {
    const label = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case "update_scene": {
        const idx = indexOf(op.sceneId);
        if (idx < 0) {
          errors.push(`${label}: scene "${op.sceneId}" does not exist.`);
          break;
        }
        const merged = SceneSchema.safeParse({ ...scenes[idx], ...op.changes });
        if (!merged.success) {
          errors.push(`${label}: ${merged.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
          break;
        }
        scenes[idx] = merged.data;
        changed.add(op.sceneId);
        break;
      }
      case "remove_scene": {
        const idx = indexOf(op.sceneId);
        if (idx < 0) errors.push(`${label}: scene "${op.sceneId}" does not exist.`);
        else {
          scenes.splice(idx, 1);
          changed.add(op.sceneId);
        }
        break;
      }
      case "insert_scene": {
        if (indexOf(op.scene.id) >= 0) {
          errors.push(`${label}: scene id "${op.scene.id}" already exists.`);
          break;
        }
        const pos = op.afterSceneId === null ? 0 : indexOf(op.afterSceneId) + 1;
        if (op.afterSceneId !== null && pos === 0) {
          errors.push(`${label}: anchor scene "${op.afterSceneId}" does not exist.`);
          break;
        }
        scenes.splice(pos, 0, op.scene);
        changed.add(op.scene.id);
        break;
      }
      case "move_scene": {
        const idx = indexOf(op.sceneId);
        if (idx < 0) {
          errors.push(`${label}: scene "${op.sceneId}" does not exist.`);
          break;
        }
        const [scene] = scenes.splice(idx, 1);
        const pos = op.afterSceneId === null ? 0 : indexOf(op.afterSceneId) + 1;
        if (op.afterSceneId !== null && pos === 0) {
          scenes.splice(idx, 0, scene as (typeof scenes)[number]);
          errors.push(`${label}: anchor scene "${op.afterSceneId}" does not exist.`);
          break;
        }
        scenes.splice(pos, 0, scene as (typeof scenes)[number]);
        changed.add(op.sceneId);
        break;
      }
      case "update_global":
        next = { ...next, ...op.changes };
        break;
      case "set_total_duration":
        newTotal = op.durationSec;
        break;
    }
  }
  next = { ...next, scenes };
  if (newTotal !== null) {
    const n = normalizeDurations(next, newTotal);
    next = n.storyboard;
    for (const s of next.scenes) changed.add(s.id);
  } else {
    // Keep the requested total: if edits changed the sum, rescale only the changed scenes'
    // neighbours is complex; instead rescale all scenes proportionally ONLY when the
    // drift is beyond tolerance, and report it.
    const total = next.scenes.reduce((s, x) => s + x.durationSec, 0);
    if (Math.abs(total - targetDuration) > Math.max(0.5, targetDuration * 0.03)) {
      errors.push(`After the edits the total duration is ${total.toFixed(2)}s instead of ${targetDuration}s. Adjust neighbouring scene durations so the total stays ${targetDuration}s, or use set_total_duration.`);
    }
  }
  return { storyboard: next, errors, changedSceneIds: [...changed] };
}

/** Which scenes differ between two storyboards (by id and content). */
export function diffStoryboards(a: Storyboard, b: Storyboard): { changed: string[]; added: string[]; removed: string[]; unchanged: string[] } {
  const am = new Map(a.scenes.map((s) => [s.id, JSON.stringify(s)]));
  const bm = new Map(b.scenes.map((s) => [s.id, JSON.stringify(s)]));
  const changed: string[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [id, v] of bm) {
    if (!am.has(id)) added.push(id);
    else if (am.get(id) !== v) changed.push(id);
    else unchanged.push(id);
  }
  for (const id of am.keys()) if (!bm.has(id)) removed.push(id);
  return { changed, added, removed, unchanged };
}
