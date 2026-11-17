// One-time local setup: .env, database, media engine check.  Usage: npm run setup
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

if (!fs.existsSync(".env")) {
  const tpl = fs.readFileSync(".env.example", "utf8").replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`);
  fs.writeFileSync(".env", tpl, { mode: 0o600 });
  console.log("✓ created .env (add ANTHROPIC_API_KEY to enable the AI agent)");
} else console.log("✓ .env already exists");

execFileSync("node_modules/.bin/prisma", ["db", "push"], { stdio: "inherit" });
const ff = process.env.FFMPEG_PATH || "node_modules/ffmpeg-static/ffmpeg";
const fp = process.env.FFPROBE_PATH || `node_modules/ffprobe-static/bin/${process.platform}/${process.arch}/ffprobe`;
for (const [name, bin] of [["FFmpeg", ff], ["FFprobe", fp]]) {
  const v = execFileSync(bin, ["-version"]).toString().split("\n")[0];
  console.log(`✓ ${name}: ${v}`);
}
const filters = execFileSync(ff, ["-hide_banner", "-filters"]).toString();
for (const f of ["ass", "xfade", "zoompan", "loudnorm", "blurdetect"]) {
  if (!new RegExp(`\\s${f}\\s`).test(filters)) console.warn(`✗ FFmpeg is missing the "${f}" filter — rendering will not work. Use the bundled binary or a full build.`);
}
console.log("\nSetup complete. Run: npm run dev  →  http://localhost:3000");
