/**
 * End-to-end smoke test against a RUNNING server (npm run dev / npm start):
 *   create project → upload media (incl. an invalid file) → plan → render → QC → download
 * Uses Basic assembly unless E2E_MODE=ai (requires ANTHROPIC_API_KEY on the server).
 *   BASE_URL=http://localhost:3000 npm run e2e
 */
import fs from "node:fs";
import path from "node:path";
import { makeSynthetic } from "../src/server/dev/synthetic";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const MODE = process.env.E2E_MODE === "ai" ? "ai" : "basic";
let cookie = "";

async function call<T = any>(p: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0] as string;
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* binary */
  }
  return { status: res.status, body };
}
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

const dir = path.resolve(".e2e-media");
fs.rmSync(dir, { recursive: true, force: true });
const files = [
  await makeSynthetic("photo_landscape", dir, "beach.jpg", 1),
  await makeSynthetic("photo_portrait", dir, "temple.png", 2),
  await makeSynthetic("photo_square", dir, "food.jpg", 3),
  await makeSynthetic("clip_landscape", dir, "boat.mp4", 4),
  await makeSynthetic("music_120bpm", dir, "track.mp3"),
];
const fake = await makeSynthetic("fake_jpg", dir, "malware.jpg");
const corrupt = await makeSynthetic("corrupt_mp4", dir, "broken.mp4");

const sys = await call("/api/system");
assert(sys.status === 200 && sys.body.media.ok, `render engine ready (${sys.body.media.ffmpegVersion})`);
const created = await call("/api/projects", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "E2E smoke reel", prompt: "A short cinematic test reel.", durationSec: 10, style: "cinematic_travel", requireApproval: true }),
});
assert(created.status === 201, "project created");
const pid = created.body.project.id;

for (const f of files) {
  const r = await call(`/api/projects/${pid}/assets`, {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(path.basename(f)), ...(f.endsWith(".mp3") ? { "x-license": encodeURIComponent(JSON.stringify({ source: "generated", license: "test fixture", attribution: "" })) } : {}) },
    body: fs.readFileSync(f),
  });
  assert(r.status === 201, `uploaded ${path.basename(f)} → ${r.body?.asset?.kind}`);
}
const bad1 = await call(`/api/projects/${pid}/assets`, { method: "POST", headers: { "x-file-name": "malware.jpg" }, body: fs.readFileSync(fake) });
assert(bad1.status === 415, `rejected disguised file: ${bad1.body?.error?.message}`);
const bad2 = await call(`/api/projects/${pid}/assets`, { method: "POST", headers: { "x-file-name": "broken.mp4" }, body: fs.readFileSync(corrupt) });
assert(bad2.status === 422, `rejected corrupt video: ${bad2.body?.error?.message}`);

// Ownership: a different browser (no cookie) cannot see this project.
const saved = cookie;
cookie = "";
const stranger = await call(`/api/projects/${pid}`);
assert(stranger.status === 404, "other users cannot access the project");
cookie = saved;

const plan = await call(`/api/projects/${pid}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: MODE }) });
assert(plan.status === 202, `planning started (${MODE})`);

async function waitIdle(label: string, timeoutMs = 20 * 60 * 1000) {
  const start = Date.now();
  let last = "";
  for (;;) {
    const d = await call(`/api/projects/${pid}`);
    const job = d.body.jobs.find((j: any) => j.status === "queued" || j.status === "running");
    if (!job) return d.body;
    const line = `${job.type} ${Math.round(job.progress * 100)}% ${job.message}`;
    if (line !== last) console.log("   …", line);
    last = line;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
let d = await waitIdle("plan");
if (d.project.stage === "needs_clarification") {
  console.log("   agent asked:", d.project.stageMessage);
  await call(`/api/projects/${pid}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: MODE, clarification: "Keep the project settings as they are." }) });
  d = await waitIdle("plan");
}
assert(d.project.stage === "plan_ready" && d.storyboard, `storyboard v${d.storyboard?.version} ready with ${d.storyboard?.data.scenes.length} scenes`);

const render = await call(`/api/projects/${pid}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storyboardVersion: d.storyboard.version }) });
assert(render.status === 202, "render started");
d = await waitIdle("render");
const r = d.renders[0];
assert(r && r.status === "passed", `render v${r?.version} passed QC (${r?.qc?.status}) — ${r?.qc?.qualityLabel}`);
assert(r.width === 1080 && r.height === 1920, `measured ${r.width}x${r.height} @ ${r.fps}fps, ${r.durationSec}s`);
for (const c of [...r.qc.technicalChecks, ...r.qc.audioChecks, ...r.qc.visualChecks]) console.log(`   ${c.status.padEnd(5)} ${c.label} — ${c.detail}`);

const range = await fetch(`${BASE}/api/projects/${pid}/renders/${r.version}/video`, { headers: { cookie, range: "bytes=0-99" } });
assert(range.status === 206, "video supports range requests (seekable preview)");
const dl = await fetch(`${BASE}/api/projects/${pid}/renders/${r.version}/video?download=1`, { headers: { cookie } });
const buf = Buffer.from(await dl.arrayBuffer());
assert(dl.status === 200 && buf.length === r.sizeBytes && buf.subarray(4, 8).toString() === "ftyp", `download is a real MP4 (${(buf.length / 1e6).toFixed(2)} MB)`);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll E2E checks passed. Project: ${BASE}/projects/${pid}`);
