/**
 * Generate a local set of synthetic demo media (no downloads, no licensing issues):
 * 8 "photos", 2 clips and 1 music track — the CLAUDE.md first-demo shape.
 *   npm run demo:assets  →  ./demo-assets/
 * Replace these with your own photos for a real creative result.
 */
import path from "node:path";
import { makeSynthetic, type SyntheticKind } from "../src/server/dev/synthetic";

const out = path.resolve(process.cwd(), process.argv[2] ?? "demo-assets");
const plan: [SyntheticKind, string][] = [
  ["photo_landscape", "01-landscape.jpg"],
  ["photo_portrait", "02-portrait.png"],
  ["photo_landscape", "03-landscape.jpg"],
  ["photo_square", "04-square.jpg"],
  ["photo_portrait", "05-portrait.png"],
  ["photo_landscape", "06-landscape.jpg"],
  ["photo_portrait", "07-portrait.png"],
  ["photo_landscape", "08-landscape.jpg"],
  ["clip_landscape", "09-clip-landscape.mp4"],
  ["clip_portrait", "10-clip-portrait.mp4"],
  ["music_120bpm", "11-music-120bpm.mp3"],
];
for (const [i, [kind, name]] of plan.entries()) {
  await makeSynthetic(kind, out, name, i + 1);
  console.log("created", path.join(out, name));
}
