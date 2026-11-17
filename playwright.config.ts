import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60 * 1000,
  expect: { timeout: 30_000 },
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000", viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure" },
  // Reuses a running `npm run dev` / `npm start`; otherwise starts the dev server.
  webServer: { command: "npm run dev", url: "http://localhost:3000/api/system", reuseExistingServer: true, timeout: 120_000 },
  reporter: [["list"]],
});
