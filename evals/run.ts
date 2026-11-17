/**
 * ReelCraft agent evaluation runner.
 *
 *   npm run eval              # offline: full on-device creative engine + objective checks (free)
 *   npm run eval -- --ai      # full Claude agent + objective checks + rubric judge (uses the Claude API; costs money)
 *   npm run eval -- --only A_travel_reel,C_low_quality
 *
 * Results are written to evals/results/<timestamp>-<mode>.json and compared with the
 * previous run of the same mode so improvements/regressions are visible.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const args = process.argv.slice(2);
const MODE = args.includes("--ai") ? "ai" : "offline";
const only = args.find((a) => a.startsWith("--only"))?.split("=")[1] ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined);

// Isolated eval database + storage.
process.env.DATABASE_URL = "file:./eval.db";
process.env.STORAGE_ROOT = path.resolve(".eval-storage");
process.env.RENDER_PRESET ??= "veryfast";
if (MODE === "offline") process.env.ANTHROPIC_API_KEY = "";
fs.rmSync(".eval-storage", { recursive: true, force: true });
fs.rmSync("prisma/eval.db", { force: true });
execFileSync("node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });

const { db, newId } = await import("../src/server/db");
const { createProject } = await import("../src/server/services/projects");
const { ingestUpload } = await import("../src/server/services/assets");
const { enqueueJob, drainQueue } = await import("../src/server/harness/jobs");
const { parseStoryboardRow } = await import("../src/server/harness/workflows");
const { diffStoryboards } = await import("../src/server/harness/revision");
const { runTool } = await import("../src/server/harness/registry");
const { inspectMediaTool } = await import("../src/server/harness/tools");
const { makeSynthetic } = await import("../src/server/dev/synthetic");
const { aiConfigured } = await import("../src/server/agent/client");
const { judgeRender } = await import("./judge");
const { QualityReportSchema, EdlSchema, CreativeBriefSchema } = await import("../src/lib/schemas");

interface Case {
  id: string;
  title: string;
  prompt: string;
  settings: Record<string, unknown>;
  assets: { kind: string; count: number }[];
  expect: { render: boolean; qualityFlagged?: boolean; upscaleLabelled?: boolean; conflictDetected?: boolean; invalidRejected?: number; noInventedClaims?: boolean; revision?: { feedback: string; openingOnlySec: number } };
}
type Check = { id: string; pass: boolean | null; detail: string };

if (MODE === "ai" && !aiConfigured()) {
  console.error("--ai requires ANTHROPIC_API_KEY in the environment.");
  process.exit(1);
}

const cases: Case[] = JSON.parse(fs.readFileSync("evals/cases/cases.json", "utf8"));
const selected = cases.filter((c) => !only || only.split(",").includes(c.id));
const user = await db.user.create({ data: { id: newId() } });
const results: { id: string; title: string; checks: Check[]; rubric: Record<string, number> | null; rubricNotes: string | null; durationMs: number; error: string | null }[] = [];

for (const c of selected) {
  const started = Date.now();
  const checks: Check[] = [];
  const add = (id: string, pass: boolean | null, detail: string) => checks.push({ id, pass, detail });
  let rubric: Record<string, number> | null = null;
  let rubricNotes: string | null = null;
  let error: string | null = null;
  console.log(`\n▶ ${c.title}`);
  try {
    const project = await createProject(user.id, { name: c.title, prompt: c.prompt, requireApproval: false, ...c.settings });
    const pid = project.id;
    const dir = path.resolve(".eval-storage/fixtures", c.id);
    let rejected = 0;
    let seed = 0;
    for (const a of c.assets) {
      for (let i = 0; i < a.count; i++) {
        const ext = a.kind.startsWith("clip") || a.kind === "corrupt_mp4" ? "mp4" : a.kind.startsWith("music") ? "mp3" : a.kind === "photo_portrait" ? "png" : "jpg";
        const file = await makeSynthetic(a.kind as never, dir, `${a.kind}_${i}.${ext}`, ++seed);
        try {
          await ingestUpload({ projectId: pid, fileName: path.basename(file), body: Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array> });
        } catch {
          rejected++;
        }
      }
    }
    if (c.expect.invalidRejected !== undefined) add("invalid_files_rejected", rejected === c.expect.invalidRejected, `${rejected} rejected (expected ${c.expect.invalidRejected})`);
    else add("all_uploads_accepted", rejected === 0, `${rejected} rejected`);

    // Permission enforcement: tools cannot reach into another project.
    const other = await createProject(user.id, { name: "other" });
    try {
      await runTool(inspectMediaTool, { projectId: other.id, assetId: "abcdefgh-0000", rel: "originals/x.jpg" }, { projectId: pid });
      add("permission_enforced", false, "cross-project tool call was allowed");
    } catch (e) {
      add("permission_enforced", (e as { code?: string }).code === "FORBIDDEN", "cross-project tool call refused");
    }

    if (c.expect.qualityFlagged) {
      const assets = await db.asset.findMany({ where: { projectId: pid } });
      const flagged = assets.filter((a) => {
        const m = JSON.parse(a.metricsJson ?? "{}");
        return m.dark || m.soft || m.blurry;
      }).length;
      add("low_quality_detected", flagged >= 4, `${flagged}/${assets.length} assets flagged dark/soft by measurement`);
    }

    await enqueueJob(pid, "plan", { mode: "ai" }); // Claude when --ai, otherwise the local creative engine
    await drainQueue();
    let p = await db.project.findUniqueOrThrow({ where: { id: pid } });
    const brief = await db.brief.findFirst({ where: { projectId: pid }, orderBy: { version: "desc" } });
    const briefData = brief ? CreativeBriefSchema.parse(JSON.parse(brief.json)) : null;

    if (c.expect.conflictDetected) {
      const detected = p.stage === "needs_clarification" || (briefData?.conflicts.length ?? 0) > 0;
      add("conflict_detected", detected, p.stage === "needs_clarification" ? `asked: ${p.stageMessage}` : `conflicts: ${JSON.stringify(briefData?.conflicts ?? [])}`);
      if (p.stage === "needs_clarification") {
        await enqueueJob(pid, "plan", { mode: "ai", clarification: "Keep the 20-second setting." });
        await drainQueue();
        p = await db.project.findUniqueOrThrow({ where: { id: pid } });
      }
    }
    if (c.expect.qualityFlagged) add("brief_mentions_limitations", (briefData?.qualityConcerns.length ?? 0) > 0, briefData?.qualityConcerns.join(" ") ?? "no brief");

    const render = await db.render.findFirst({ where: { projectId: pid, status: "passed" }, orderBy: { version: "desc" } });
    const anyRender = await db.render.findFirst({ where: { projectId: pid }, orderBy: { version: "desc" } });
    const edlRow = anyRender ? await db.edl.findFirst({ where: { projectId: pid, version: anyRender.edlVersion } }) : null;
    if (edlRow) add("edl_valid", edlRow.valid && EdlSchema.safeParse(JSON.parse(edlRow.json)).success, edlRow.valid ? "schema + constraints OK" : edlRow.validationJson);
    if (c.expect.render || anyRender) {
      add("render_completed", Boolean(render), render ? `v${render.version} passed` : `stage=${p.stage} ${p.stageMessage}`);
      if (render) {
        const qc = QualityReportSchema.parse(JSON.parse(render.qcJson ?? "{}"));
        const target = project.durationSec;
        add("duration_accuracy", Math.abs((render.durationSec ?? 0) - target) <= Math.max(0.12, target * 0.01), `${render.durationSec?.toFixed(2)}s vs ${target}s`);
        add("aspect_ratio", render.width === project.width && render.height === project.height, `${render.width}x${render.height}`);
        add("file_readable", qc.technicalChecks.find((x) => x.id === "decodable")?.status === "pass", "full decode");
        const expectsAudio = c.assets.some((a) => a.kind.startsWith("music"));
        add("required_streams", (qc.output.audioCodec !== null) === expectsAudio && qc.output.videoCodec === "h264", `video=${qc.output.videoCodec} audio=${qc.output.audioCodec}`);
        if (c.expect.upscaleLabelled) {
          // Honesty check: the label mentions upscaling if and only if a clip was actually upscaled.
          const renderedEdl = await db.edl.findFirst({ where: { projectId: pid, version: render.edlVersion } });
          const upscaled = renderedEdl ? EdlSchema.parse(JSON.parse(renderedEdl.json)).clips.filter((cl) => cl.upscaled).length : 0;
          add("upscaling_labelled_honestly", /upscaled/.test(qc.qualityLabel) === upscaled > 0, `${upscaled} upscaled clip(s); label "${qc.qualityLabel}"`);
        }
        if (MODE === "ai") {
          const sbRow = await db.storyboard.findFirst({ where: { projectId: pid }, orderBy: { version: "desc" } });
          const j = await judgeRender({ projectId: pid, prompt: c.prompt, storyboard: sbRow ? parseStoryboardRow(sbRow) : null, report: qc });
          rubric = j.scores;
          rubricNotes = j.notes;
          if (c.expect.noInventedClaims) add("no_invented_claims", !j.inventedClaims, j.inventedClaimsDetail || "none found");
        }
      }
    }

    if (c.expect.revision) {
      if (render) {
        const before = await db.storyboard.findFirstOrThrow({ where: { projectId: pid }, orderBy: { version: "desc" } });
        const fb = await db.feedback.create({ data: { id: newId(), projectId: pid, message: c.expect.revision.feedback } });
        await enqueueJob(pid, "revise", { feedbackId: fb.id });
        await drainQueue();
        const after = await db.storyboard.findFirstOrThrow({ where: { projectId: pid }, orderBy: { version: "desc" } });
        const a = parseStoryboardRow(before);
        const b = parseStoryboardRow(after);
        const d = diffStoryboards(a, b);
        let t = 0;
        const openingIds = new Set(a.scenes.filter((s) => { const st = t; t += s.durationSec; return st < c.expect.revision!.openingOnlySec; }).map((s) => s.id));
        const outside = [...d.changed, ...d.removed].filter((id) => !openingIds.has(id));
        add("revision_changed_opening", d.changed.some((id) => openingIds.has(id)) || d.added.length > 0, `changed=${d.changed.join(",")} added=${d.added.join(",")}`);
        add("revision_scoped", outside.length <= 1, `outside opening changed: ${outside.join(",") || "none"} (≤1 neighbour allowed for timing compensation)`);
        const rv = await db.render.findFirst({ where: { projectId: pid }, orderBy: { version: "desc" } });
        add("revision_rendered", rv?.status === "passed", `v${rv?.version} ${rv?.status}`);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    add("case_ran", false, error);
  }
  const r = { id: c.id, title: c.title, checks, rubric, rubricNotes, durationMs: Date.now() - started, error };
  results.push(r);
  for (const ch of checks) console.log(`   ${ch.pass === null ? "SKIP" : ch.pass ? "PASS" : "FAIL"}  ${ch.id} — ${ch.detail}`);
  if (rubric) console.log(`   rubric: ${Object.entries(rubric).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

const usage = await db.modelCall.aggregate({ _sum: { inputTokens: true, outputTokens: true }, _count: true });
const all = results.flatMap((r) => r.checks).filter((c) => c.pass !== null);
const summary = {
  mode: MODE,
  at: new Date().toISOString(),
  passRate: all.length ? all.filter((c) => c.pass).length / all.length : 0,
  checksPassed: all.filter((c) => c.pass).length,
  checksTotal: all.length,
  rubricMean: (() => {
    const v = results.flatMap((r) => Object.values(r.rubric ?? {}));
    return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;
  })(),
  modelCalls: usage._count,
  tokens: { input: usage._sum.inputTokens ?? 0, output: usage._sum.outputTokens ?? 0 },
};
fs.mkdirSync("evals/results", { recursive: true });
const prev = fs.readdirSync("evals/results").filter((f) => f.endsWith(`-${MODE}.json`)).sort().at(-1);
const out = `evals/results/${summary.at.replace(/[:.]/g, "-")}-${MODE}.json`;
fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
console.log(`\n=== ${MODE.toUpperCase()} EVAL: ${summary.checksPassed}/${summary.checksTotal} checks passed (${Math.round(summary.passRate * 100)}%)${summary.rubricMean !== null ? `, rubric mean ${summary.rubricMean}/5` : ""} ===`);
if (prev) {
  const p = JSON.parse(fs.readFileSync(path.join("evals/results", prev), "utf8")).summary;
  console.log(`Previous (${prev}): ${p.checksPassed}/${p.checksTotal}${p.rubricMean !== null ? `, rubric ${p.rubricMean}` : ""} → Δ pass rate ${((summary.passRate - p.passRate) * 100).toFixed(1)} pts`);
}
console.log(`Saved ${out}`);
process.exit(all.every((c) => c.pass) ? 0 : 1);
