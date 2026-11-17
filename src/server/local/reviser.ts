import type { RevisionOp, RevisionPlan, Scene, Storyboard } from "@/lib/schemas";
import type { ColorGrade, MotionId, TransitionId } from "@/lib/presets";
import type { AgentAsset } from "../agent/context";
import { extractQuoted, parseDurationSec } from "./brief";

/**
 * On-device revision interpreter: plain-English feedback → controlled storyboard edit
 * operations (the same op format the Claude path uses, validated by the same harness).
 * Unrecognised requests produce a clarification question instead of a guess.
 */

const STYLISED = new Set<TransitionId>(["smooth_left", "smooth_up", "slide_left", "slide_up", "wipe_left", "circle_open", "zoom_in", "radial", "fade_white", "fade_black"]);

const r2 = (v: number) => Math.round(v * 100) / 100;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !["img", "dsc", "photo", "image", "video", "clip", "mov", "mp4", "jpg", "png", "the"].includes(t));
}

/** Find an asset the user refers to by name ("the beach photo") or ordinal ("the second clip"). */
export function findAssetRef(text: string, assets: AgentAsset[], sb: Storyboard): AgentAsset | undefined {
  const t = text.toLowerCase();
  const visuals = assets.filter((a) => a.kind !== "audio" && !a.excluded);
  let best: { a: AgentAsset; score: number } | undefined;
  for (const a of visuals) {
    const words = new Set([...tokens(a.originalName), ...(a.analysis?.dominantColors ?? [])]);
    let score = 0;
    for (const w of words) if (w.length >= 3 && new RegExp(`\\b${w.replace(/[^a-z0-9 ]/g, "")}\\b`).test(t)) score += w.length;
    if (score > 0 && (!best || score > best.score)) best = { a, score };
  }
  if (best) return best.a;
  const ord = /\b(first|second|third|fourth|fifth|last)\s+(photo|picture|image|clip|video|shot)\b/.exec(t);
  if (ord) {
    const kind = /clip|video/.test(ord[2] as string) ? "video" : /photo|picture|image/.test(ord[2] as string) ? "image" : null;
    const list = visuals.filter((a) => !kind || a.kind === kind);
    const idx = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: list.length - 1 }[ord[1] as "first"];
    return list[idx];
  }
  void sb;
  return undefined;
}

function sceneStarts(sb: Storyboard): number[] {
  let t = 0;
  return sb.scenes.map((s) => {
    const st = t;
    t += s.durationSec;
    return st;
  });
}

export function planLocalRevision(opts: { storyboard: Storyboard; feedback: string; assets: AgentAsset[]; durationSec: number }): RevisionPlan {
  const sb = opts.storyboard;
  const fb = opts.feedback.trim();
  const t = fb.toLowerCase();
  const ops: RevisionOp[] = [];
  const notes: string[] = [];
  const changes = new Map<string, Partial<Scene>>();
  const sceneById = new Map(sb.scenes.map((s) => [s.id, s]));
  const upd = (id: string, c: Partial<Scene>) => changes.set(id, { ...(changes.get(id) ?? {}), ...c });
  const cur = (id: string): Scene => ({ ...(sceneById.get(id) as Scene), ...(changes.get(id) ?? {}) });
  const global: Extract<RevisionOp, { op: "update_global" }>["changes"] = {};
  let total: number | null = null;
  const has = (re: RegExp) => re.test(t);
  const D = opts.durationSec;
  const starts = sceneStarts(sb);

  // Move time from/to a neighbour so the total stays fixed.
  const shiftDuration = (id: string, newDur: number) => {
    const i = sb.scenes.findIndex((s) => s.id === id);
    const old = cur(id).durationSec;
    const delta = r2(newDur - old);
    if (Math.abs(delta) < 0.01) return;
    const nb = sb.scenes[i + 1] ?? sb.scenes[i - 1];
    if (!nb) return;
    const nbDur = cur(nb.id).durationSec - delta;
    if (nbDur < 0.8) return;
    upd(id, { durationSec: r2(newDur) });
    upd(nb.id, { durationSec: r2(nbDur) });
  };

  // ---- Total duration ----
  // Only explicit length requests ("make it 20 seconds", "a 15-second version"), never "first 3 seconds".
  const forTotal = fb.replace(/\b(first|last|opening|final)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b/gi, "");
  const num = parseDurationSec(forTotal);
  const lengthVerb = /\b(make (it|the video|the reel)|cut (it )?(down )?to|trim (it )?to|shorten (it )?to|extend (it )?to|change (it|the length|the duration) to|reduce (it )?to|length (to|of)|duration (to|of)|keep it (to|at|under))\b/i.test(forTotal) || /\d+\s*-?\s*(second|sec|minute)s?\s*(long|video|reel|version|cut|edit)\b/i.test(forTotal);
  if (num !== null && lengthVerb && num >= 3 && num <= 180) {
    total = num;
    notes.push(`change the total length to ${num}s (scenes rescaled proportionally)`);
  } else if (has(/\bmake it (shorter|quicker)\b|\btoo long\b/)) {
    total = Math.max(5, Math.round(D * 0.75));
    notes.push(`shorten the video to ${total}s`);
  } else if (has(/\bmake it longer\b|\btoo short\b/)) {
    total = Math.min(180, Math.round(D * 1.3));
    notes.push(`lengthen the video to ${total}s`);
  }

  // ---- Use an asset first / last ----
  const firstReq = /\b(use|put|start with|open with|begin with)\b.*\b(first|to start|as the opening|at the start|to open)\b|\b(start|open|begin) with\b/.test(t);
  const lastReq = /\b(use|put|end with|finish with|close with)\b.*\b(last|at the end|to end|as the ending|to finish)\b/.test(t) && !/\b(text|words|saying)\b/.test(t);
  if (firstReq || lastReq) {
    const a = findAssetRef(fb, opts.assets, sb);
    if (a) {
      const existing = sb.scenes.find((s) => s.assetId === a.id);
      if (firstReq) {
        if (existing && existing.id !== sb.scenes[0]?.id) {
          ops.push({ op: "move_scene", sceneId: existing.id, afterSceneId: null });
          notes.push(`move "${a.originalName}" to the opening`);
        } else if (!existing) {
          upd(sb.scenes[0]!.id, { assetId: a.id, focus: a.analysis?.focalPoint ?? null, sourceInSec: 0, motion: a.kind === "video" ? "none" : "push_in", visualDescription: `${a.kind === "video" ? "Clip" : "Photo"} "${a.originalName}"` });
          notes.push(`open on "${a.originalName}"`);
        } else notes.push(`"${a.originalName}" already opens the video`);
      } else if (existing) {
        ops.push({ op: "move_scene", sceneId: existing.id, afterSceneId: sb.scenes[sb.scenes.length - 1]!.id === existing.id ? sb.scenes[sb.scenes.length - 2]?.id ?? null : sb.scenes[sb.scenes.length - 1]!.id });
        notes.push(`move "${a.originalName}" to the end`);
      }
    } else if (/\b(photo|picture|image|clip|video|shot)\b/.test(t)) {
      return clarify(`I couldn't tell which file you mean. Please use part of its file name, e.g. "use the ${tokens(opts.assets.find((x) => x.kind !== "audio")?.originalName ?? "beach")[0] ?? "beach"} photo first".`);
    }
  }

  // ---- Remove scenes ----
  const rmScene = /\bremove (?:the )?(?:scene|shot|clip) (\d+)\b/.exec(t);
  if (rmScene) {
    const s = sb.scenes[Number(rmScene[1]) - 1];
    if (!s) return clarify(`There is no scene ${rmScene[1]}; the plan has ${sb.scenes.length} scenes.`);
    ops.push({ op: "remove_scene", sceneId: s.id });
    total ??= D;
    notes.push(`remove scene ${rmScene[1]} and rebalance timing`);
  } else if (/\b(remove|delete|drop|cut out|take out)\b/.test(t) && /\b(photo|picture|image|clip|video|shot|scene)\b/.test(t)) {
    const a = findAssetRef(fb, opts.assets, sb);
    const targets = a ? sb.scenes.filter((s) => s.assetId === a.id) : [];
    if (!targets.length) return clarify(`Which one should I remove? Say "remove scene 3" (scenes are numbered in the plan) or use part of the file name.`);
    if (targets.length >= sb.scenes.length) return clarify("That would remove every scene. Which part should stay?");
    for (const s of targets) ops.push({ op: "remove_scene", sceneId: s.id });
    total ??= D;
    notes.push(`remove "${a!.originalName}" and rebalance timing`);
  }

  // ---- Opening energy ----
  const openingRef = /\b(opening|intro|beginning|start|hook|first (?:\d+|few|couple of|two|three)?\s*(?:seconds?|secs?|shots?|scenes?))\b/.test(t);
  const openSec = (() => {
    const m = /first (\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/.exec(t);
    return m ? Number(m[1]) : 3;
  })();
  if (openingRef && /\b(exciting|engaging|punch|punchier|energ|dynamic|stronger|better|grab|impact|catchy|attention|faster|more interesting|wow)\w*/.test(t) && !firstReq) {
    const opening = sb.scenes.filter((_, i) => (starts[i] as number) < openSec);
    const best = [...opts.assets].filter((a) => a.kind !== "audio" && !a.excluded).sort((x, y) => (y.analysis?.hookStrength ?? 0) - (x.analysis?.hookStrength ?? 0))[0];
    opening.forEach((s, i) => {
      const a = opts.assets.find((x) => x.id === s.assetId);
      const isImage = a?.kind === "image";
      upd(s.id, {
        motion: isImage ? (i % 2 === 0 ? "push_in" : "pull_out") : s.motion,
        motionIntensity: "strong",
        transitionIn: i === 0 ? { type: "cut", durationSec: 0 } : { type: "zoom_in", durationSec: 0.3 },
        ...(s.text ? { text: { ...s.text, animation: "fade_scale" as const, style: i === 0 ? ("title" as const) : s.text.style } } : {}),
      });
      if (i === 0 && cur(s.id).durationSec > 2.2) shiftDuration(s.id, Math.max(1.6, r2(cur(s.id).durationSec * 0.7)));
    });
    const s1 = sb.scenes[0]!;
    const s1Hook = opts.assets.find((x) => x.id === s1.assetId)?.analysis?.hookStrength ?? 0;
    if (best && best.id !== s1.assetId && (best.analysis?.hookStrength ?? 0) > s1Hook && !sb.scenes.some((s) => s.assetId === best.id)) {
      upd(s1.id, { assetId: best.id, focus: best.analysis?.focalPoint ?? null, sourceInSec: 0, motion: best.kind === "video" ? "none" : "push_in" });
      notes.push(`open on the stronger "${best.originalName}" shot`);
    }
    notes.push(`make the first ${openSec}s punchier: hard cut in, stronger camera push, faster first shot and a quick zoom transition`);
  } else if (openingRef && /\b(calm|calmer|slower|softer|gentler)\b/.test(t)) {
    const s1 = sb.scenes[0]!;
    upd(s1.id, { motionIntensity: "subtle", transitionIn: { type: "fade", durationSec: 0.8 } });
    notes.push("make the opening calmer with a gentle fade-in and subtle motion");
  }

  // ---- Transitions ----
  if (/\b(no|without) transitions\b|\bonly (hard )?cuts\b|\bhard cuts\b/.test(t)) {
    sb.scenes.slice(1).forEach((s) => upd(s.id, { transitionIn: { type: "cut", durationSec: 0 } }));
    notes.push("replace all transitions with clean cuts");
  } else if (/\b(reduce|fewer|less|simpler|simplify|tone down|too many)\b.*\btransitions?\b|\btransitions?\b.*\b(less|simpler|too much|too many|distracting)\b/.test(t)) {
    sb.scenes.slice(1).forEach((s, i) => {
      const tr = cur(s.id).transitionIn;
      if (STYLISED.has(tr.type) || tr.durationSec > 0.6) upd(s.id, { transitionIn: i % 2 === 0 ? { type: "cut", durationSec: 0 } : { type: "fade", durationSec: 0.4 } });
    });
    notes.push("simplify transitions to cuts and short crossfades");
  } else if (/\b(smoother|softer|more fluid)\b.*\btransitions?\b|\btransitions?\b.*\b(smoother|softer)\b/.test(t)) {
    sb.scenes.slice(1).forEach((s) => upd(s.id, { transitionIn: { type: "dissolve", durationSec: 0.7 } }));
    notes.push("use smooth dissolves between scenes");
  }

  // ---- Text ----
  const textRef = /\b(text|captions?|titles?|font|words|subtitles?|typography)\b/.test(t);
  if (/\b(remove|no|hide|without) (all )?(the )?(text|captions|titles|words)\b/.test(t)) {
    sb.scenes.forEach((s) => s.text && upd(s.id, { text: null }));
    global.endCard = null;
    notes.push("remove all on-screen text");
  } else if (textRef && /\b(smaller|tiny|less big|too big|too large|reduce)\b/.test(t)) {
    global.textScale = Math.max(0.7, r2((sb.textScale ?? 1) * 0.85));
    notes.push(`make text smaller (${Math.round(global.textScale * 100)}% size)`);
  } else if (textRef && /\b(bigger|larger|too small|more readable|hard to read|increase)\b/.test(t)) {
    global.textScale = Math.min(1.4, r2((sb.textScale ?? 1) * 1.15));
    notes.push(`make text larger (${Math.round(global.textScale * 100)}% size)`);
  }
  if (/\b(background|box|backdrop|panel)\b.*\b(text|captions?)\b|\b(text|captions?)\b.*\b(background|box|backdrop)\b|\bhard to read\b|\bmore legible\b/.test(t)) {
    sb.scenes.forEach((s) => {
      const tx = cur(s.id).text;
      if (tx && tx.style !== "title") upd(s.id, { text: { ...tx, style: "label" } });
    });
    notes.push("put captions on a translucent box for legibility");
  }
  const anim = /\btypewriter\b|\btyped\b/.test(t) ? "typewriter" : /\bpop\b|\bbounce\b/.test(t) ? "pop" : /\bslide\b.*\btext\b|\btext\b.*\bslide\b/.test(t) ? "slide_in" : /\b(simple|plain|gentle) (text|captions?)\b/.test(t) ? "fade" : null;
  if (anim && textRef) {
    sb.scenes.forEach((s) => {
      const tx = cur(s.id).text;
      if (tx) upd(s.id, { text: { ...tx, animation: anim } });
    });
    notes.push(`animate text with a ${anim.replace("_", "-")} effect`);
  }
  const quoted = extractQuoted(fb);
  if (quoted.length) {
    const q = quoted[0] as string;
    if (/\b(title|headline)\b/.test(t)) {
      const s1 = sb.scenes[0]!;
      upd(s1.id, { text: { content: q, style: "title", position: s1.text?.position ?? "lower_third", animation: s1.text?.animation ?? "rise" } });
      global.title = q;
      notes.push(`set the title to "${q}"`);
    } else if (/\b(end|ending|finish|close|last)\b/.test(t)) {
      global.endCard = { text: q.slice(0, 80), subtext: null };
      notes.push(`end with "${q}"`);
    } else if (/\b(add|include|put|show|caption)\b/.test(t)) {
      const target = sb.scenes.slice(1).find((s) => !cur(s.id).text) ?? sb.scenes[sb.scenes.length - 1]!;
      upd(target.id, { text: { content: q.slice(0, 120), style: "caption", position: "lower_third", animation: "fade" } });
      notes.push(`add the caption "${q}"`);
    }
  }

  // ---- Colour ----
  const grade = ((): ColorGrade | null => {
    if (/\b(black and white|black & white|monochrome|b&w|greyscale|grayscale)\b/.test(t)) return "black_white";
    if (/\b(more )?natural\b|\brealistic colou?rs?\b|\bless (edited|filtered)\b/.test(t)) return "natural";
    if (/\bwarmer\b|\bmore warm\b|\bgolden\b/.test(t)) return "warm_natural";
    if (/\bcooler\b|\bcolder\b|\bmore blue\b/.test(t)) return "cool_crisp";
    if (/\b(more )?(vibrant|saturated|colou?rful|punchy colou?rs?)\b/.test(t)) return "vibrant";
    if (/\bvintage\b|\bretro\b|\bfilm look\b/.test(t)) return "vintage_film";
    if (/\bbrighter\b|\bmore airy\b|\blighter\b/.test(t)) return "bright_airy";
    if (/\bmoodier\b|\bdarker\b|\bmore moody\b/.test(t)) return "moody_dark";
    if (/\bcinematic (look|colou?rs?|grade)\b|\bteal\b/.test(t)) return "cinematic_teal_orange";
    return null;
  })();
  if (grade && /\b(colou?rs?|grade|grading|look|tones?|warmer|cooler|brighter|darker|black and white|monochrome|vibrant|natural|vintage|moodier)\b/.test(t)) {
    global.colorGrade = grade;
    global.gradeIntensity = grade === "natural" ? 0.5 : /\b(subtle|slightly|a bit|little)\b/.test(t) ? 0.5 : 0.75;
    notes.push(`switch the colour grade to ${grade.replace(/_/g, " ")}`);
  } else if (/\b(less|tone down|softer)\b.*\b(colou?r|grade|filter|saturation)\b/.test(t)) {
    global.gradeIntensity = Math.max(0.2, r2(sb.gradeIntensity * 0.6));
    notes.push("tone down the colour grade");
  }

  // ---- Pace ----
  const slower = /\b(slower|slow down|calmer|more emotional|relaxed|let (the )?shots breathe|less rushed|too fast)\b/.test(t) && !openingRef;
  const faster = /\b(faster|quicker|more energetic|punchier|speed up|too slow|more cuts|energetic)\b/.test(t) && !openingRef;
  const targetTotal = total ?? D;
  if (slower) {
    const want = Math.max(1, Math.round(targetTotal / 3.6));
    const removable = sb.scenes.slice(1, -1).filter((s) => !ops.some((o) => o.op === "remove_scene" && o.sceneId === s.id));
    const ranked = removable.sort((x, y) => (opts.assets.find((a) => a.id === x.assetId)?.analysis?.hookStrength ?? 3) - (opts.assets.find((a) => a.id === y.assetId)?.analysis?.hookStrength ?? 3));
    const excess = Math.max(0, sb.scenes.length - want);
    for (const s of ranked.slice(0, excess)) ops.push({ op: "remove_scene", sceneId: s.id });
    sb.scenes.forEach((s, i) => {
      if (i > 0) upd(s.id, { transitionIn: { type: "fade", durationSec: 0.8 } });
      upd(s.id, { motionIntensity: "subtle" });
    });
    total = targetTotal;
    notes.push(`slow the pace: ${excess ? `${excess} fewer shot${excess === 1 ? "" : "s"}, ` : ""}longer holds, gentle crossfades and subtle motion`);
  } else if (faster) {
    const want = Math.min(60, Math.round(targetTotal / 1.6));
    const add = Math.max(0, want - sb.scenes.length);
    const motions: MotionId[] = ["push_in", "pan_left", "pull_out", "pan_right", "drift"];
    const visuals = opts.assets.filter((a) => a.kind !== "audio" && !a.excluded);
    let anchor = sb.scenes[sb.scenes.length - 2]?.id ?? sb.scenes[0]!.id;
    for (let k = 0; k < add && visuals.length; k++) {
      const a = visuals[k % visuals.length]!;
      const id = `s${sb.scenes.length + k + 1}`;
      ops.push({
        op: "insert_scene",
        afterSceneId: anchor,
        scene: { id, purpose: "Extra beat", durationSec: 1.6, assetId: a.id, sourceInSec: a.kind === "video" ? Math.min(1, Math.max(0, (a.durationSec ?? 2) - 2)) : 0, fit: (a.width ?? 1) > (a.height ?? 1) * 1.05 ? "contain_blur" : "cover", focus: a.analysis?.focalPoint ?? null, motion: a.kind === "video" ? "none" : (motions[k % motions.length] as MotionId), motionIntensity: "medium", transitionIn: { type: "cut", durationSec: 0 }, text: null, useClipAudio: false, clipAudioVolume: 0, visualDescription: `${a.kind === "video" ? "Clip" : "Photo"} "${a.originalName}"`, musicCue: "", reason: "Added to raise the cutting rhythm." },
      });
      anchor = id;
    }
    sb.scenes.slice(1).forEach((s) => upd(s.id, { transitionIn: { type: "cut", durationSec: 0 }, motionIntensity: "medium" }));
    total = targetTotal;
    notes.push(`speed up the pace: ${add ? `${add} extra quick shot${add === 1 ? "" : "s"}, ` : ""}hard cuts and livelier motion`);
  }

  // ---- Motion ----
  if (/\b(no|stop the|without) (zoom|zooming|movement|motion|ken burns)\b|\bstatic shots?\b/.test(t)) {
    sb.scenes.forEach((s) => upd(s.id, { motion: "none" }));
    notes.push("remove camera motion");
  } else if (/\b(less|reduce|too much|subtler|calmer)\b.*\b(zoom|zooming|movement|motion|camera)\b|\b(zoom|motion|movement)\b.*\b(too much|less)\b/.test(t)) {
    sb.scenes.forEach((s) => upd(s.id, { motionIntensity: "subtle" }));
    notes.push("make camera motion subtler");
  } else if (/\bmore (zoom|movement|motion|camera movement|dynamic camera)\b/.test(t)) {
    sb.scenes.forEach((s) => upd(s.id, { motionIntensity: "strong", ...(cur(s.id).motion === "none" && opts.assets.find((a) => a.id === s.assetId)?.kind === "image" ? { motion: "push_in" as const } : {}) }));
    notes.push("add more camera movement");
  }

  // ---- Music ----
  if (/\b(no|remove( the)?|without|mute( the)?) music\b|\bmute\b/.test(t)) {
    global.music = null;
    notes.push("remove the music");
  } else if (sb.music && /\b(quieter|lower|softer|too loud|turn down)\b.*\bmusic\b|\bmusic\b.*\b(quieter|lower|too loud|softer)\b/.test(t)) {
    global.music = { ...sb.music, volume: Math.max(0.1, r2(sb.music.volume * 0.7)) };
    notes.push("lower the music level");
  } else if (sb.music && /\b(louder|higher|turn up|too quiet)\b.*\bmusic\b|\bmusic\b.*\b(louder|too quiet)\b/.test(t)) {
    global.music = { ...sb.music, volume: Math.min(1.5, r2(sb.music.volume * 1.3)) };
    notes.push("raise the music level");
  } else if (sb.music && /\b(on|to|with) (the )?beat\b|\bbeat ?sync/.test(t)) {
    global.music = { ...sb.music, beatSync: true };
    notes.push("sync cuts to the beat");
  }

  // ---- Ending ----
  if (/\b(ending|end|finish|outro)\b/.test(t) && /\b(better|stronger|memorable|nicer|more satisfying|longer|impact)\b/.test(t) && !quoted.length) {
    const last = sb.scenes[sb.scenes.length - 1]!;
    upd(last.id, { motion: opts.assets.find((a) => a.id === last.assetId)?.kind === "image" ? "pull_out" : "none", motionIntensity: "subtle" });
    shiftDuration(last.id, r2(cur(last.id).durationSec * 1.3));
    global.fadeOutEnding = true;
    notes.push("make the ending more memorable: longer final hold, gentle pull-out and fade");
  } else if (/\bno fade\b|\bhard ending\b/.test(t)) {
    global.fadeOutEnding = false;
    notes.push("end without a fade");
  } else if (/\bfade out\b/.test(t)) {
    global.fadeOutEnding = true;
    notes.push("fade out at the end");
  }

  for (const [sceneId, c] of changes) if (!ops.some((o) => o.op === "remove_scene" && o.sceneId === sceneId)) ops.push({ op: "update_scene", sceneId, changes: c });
  if (Object.keys(global).length) ops.push({ op: "update_global", changes: global });
  if (total !== null) ops.push({ op: "set_total_duration", durationSec: total });

  if (ops.length === 0) {
    return clarify(
      'I couldn\'t map that request to an edit yet. Try one of: "make the opening more exciting", "use the beach photo first", "reduce the transitions", "make the text smaller", "make the colours more natural", "use a slower, emotional pace", "remove scene 3", "make it 20 seconds", "lower the music", or "end with \\"See you soon\\"".',
    );
  }
  const touched = new Set<string>(ops.flatMap((o) => ("sceneId" in o ? [o.sceneId] : [])));
  const globalTouch = total !== null;
  return {
    understanding: `I'll ${notes.join("; ")}.`.slice(0, 600),
    ops,
    untouchedSceneIds: globalTouch ? [] : sb.scenes.map((s) => s.id).filter((id) => !touched.has(id)),
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function clarify(q: string): RevisionPlan {
  return { understanding: "", ops: [], untouchedSceneIds: [], needsClarification: true, clarificationQuestion: q.slice(0, 400) };
}
