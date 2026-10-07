/**
 * End-to-end suite (tests/e2e): the test-plan journeys against a running development server with the mock payment
 * provider and the console email transport (codes and links come from /dev/mailbox). Run: `pnpm e2e` (or
 * `npx playwright test`); one project: `--project=desktop` / `--project=mobile`.
 *
 * - E2E_BASE_URL (default http://localhost:3000) is the server; the suite never starts one (the dev server is shared).
 * - One worker: the journeys share one database and one set of seeded people.
 * - No retries: a failure is a failure (the trace of the first failing run is kept in test-results/).
 * - Reports: list in the terminal, HTML in playwright-report/ (`npx playwright show-report`).
 * - Uses the locally installed Google Chrome (channel "chrome"); no browser download needed.
 * See tests/e2e/support/env.ts for the other E2E_* switches.
 */
import { defineConfig } from "@playwright/test";

const baseURL = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").origin;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Journeys wait on a development server that compiles routes on first use and on asynchronous webhooks.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    channel: "chrome",
    headless: true,
    trace: "retain-on-first-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts$/,
      use: { viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
});
