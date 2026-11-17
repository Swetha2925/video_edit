import path from "node:path";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { makeSynthetic } from "../../src/server/dev/synthetic";

/**
 * UI end-to-end: create project → upload media → plan (local creative engine) → edit caption →
 * render → quality report → natural-language revision → export. Real uploads, FFmpeg, checks.
 */
const shots = process.env.E2E_SHOTS_DIR;

test("user can go from media to a verified, downloadable reel", async ({ page }) => {
  const dir = path.resolve(".e2e-media/ui");
  fs.rmSync(dir, { recursive: true, force: true });
  const files = [
    await makeSynthetic("photo_landscape", dir, "sunrise.jpg", 5),
    await makeSynthetic("photo_portrait", dir, "street.png", 6),
    await makeSynthetic("clip_portrait", dir, "walk.mp4", 7),
  ];

  await page.goto("/projects/new");
  await page.getByPlaceholder("Kerala travel reel").fill("UI test reel");
  await page.getByPlaceholder(/Make a 30-second/).fill('A warm cinematic travel reel, not overly flashy. End with the text "See you soon".');
  await page.getByLabel("Duration in seconds").fill("8");
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page.getByRole("heading", { name: "UI test reel" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByText("sunrise.jpg").last()).toBeVisible();
  await expect(page.getByText("walk.mp4").last()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("img[alt='street.png']")).toBeVisible({ timeout: 60_000 });
  if (shots) await page.screenshot({ path: `${shots}/ui-media.png`, fullPage: true });

  await page.getByRole("button", { name: /^Plan my video/ }).first().click();
  await expect(page.getByRole("heading", { name: /Storyboard v1/ })).toBeVisible({ timeout: 60_000 });
  // Edit on-screen text before rendering → creates storyboard v2.
  await expect(page.getByText("Planned by the local creative engine", { exact: false })).toBeVisible();
  await page.getByLabel("On-screen text for scene 2").fill("Golden hour streets");
  await page.getByRole("button", { name: "Save text edits" }).click();
  await expect(page.getByRole("heading", { name: /Storyboard v2/ })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ui-plan.png`, fullPage: true });

  await page.getByRole("button", { name: /Approve & render|Render this plan/ }).click();
  await expect(page.getByText(/Passed (all quality checks|with warnings)/)).toBeVisible({ timeout: 10 * 60 * 1000 });
  await expect(page.getByText("Resolution matches requested output")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ui-render.png`, fullPage: true });

  await expect(page.getByText("On-device checks of frames from the actual render", { exact: false })).toBeVisible();

  // Natural-language revision through the chat box.
  await page.getByLabel("Describe the change you want").fill("Make the text smaller");
  await page.getByRole("button", { name: "Revise" }).click();
  await expect(page.getByText(/make text smaller/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("v2", { exact: true })).toBeVisible({ timeout: 10 * 60 * 1000 });
  await expect(page.getByText(/Passed (all quality checks|with warnings)/)).toBeVisible({ timeout: 10 * 60 * 1000 });

  await page.getByRole("button", { name: /Export/ }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download MP4" }).click()]);
  // Auto-fix may add versions; the export is always the newest render that passed QC.
  expect(download.suggestedFilename()).toMatch(/ui-test-reel-v\d+-1080x1920\.mp4/);
  if (shots) await page.screenshot({ path: `${shots}/ui-export.png`, fullPage: true });
});
