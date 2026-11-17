import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function setup() {
  const root = process.cwd();
  fs.rmSync(path.join(root, ".test-storage"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "prisma", "test.db"), { force: true });
  execFileSync(path.join(root, "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
}
