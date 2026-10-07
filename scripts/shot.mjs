/**
 * Dev tool: screenshot a URL with the locally installed Google Chrome (no Playwright browser download needed).
 *
 *   node scripts/shot.mjs <url> <out.png> [--width=1280] [--height=900] [--full] [--slices=4] [--wait=800]
 *     [--click=<css selector>] [--hover=<css selector>] [--scroll=<css selector>]
 *
 * --full     one full-page image (can be very tall)
 * --slices=N N viewport-sized images from the top (out-1.png, out-2.png, ...), easier to read than one tall image
 * Prints the files written and any console errors from the page.
 */
import { chromium } from "@playwright/test";

const [, , url, out, ...rest] = process.argv;
if (!url || !out) {
  console.error("usage: node scripts/shot.mjs <url> <out.png> [--width=1280] [--height=900] [--full] [--slices=N] [--wait=ms] [--click=sel] [--hover=sel] [--scroll=sel]");
  process.exit(2);
}
const opt = Object.fromEntries(rest.map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const width = Number(opt.width ?? 1280);
const height = Number(opt.height ?? 900);
const wait = Number(opt.wait ?? 800);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(wait);
  if (opt.scroll) await page.locator(opt.scroll).first().scrollIntoViewIfNeeded();
  if (opt.hover) await page.locator(opt.hover).first().hover();
  if (opt.click) { await page.locator(opt.click).first().click(); await page.waitForTimeout(wait); }
  const written = [];
  if (opt.slices) {
    const n = Number(opt.slices);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 0; i < n && i * height < total; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), i * height);
      await page.waitForTimeout(250);
      const file = out.replace(/\.png$/, `-${i + 1}.png`);
      await page.screenshot({ path: file });
      written.push(file);
    }
  } else {
    await page.screenshot({ path: out, fullPage: opt.full === "true" });
    written.push(out);
  }
  console.info(JSON.stringify({ written, pageHeight: await page.evaluate(() => document.documentElement.scrollHeight), errors }, null, 1));
} finally {
  await browser.close();
}
