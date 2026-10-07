/**
 * Per-context guards every E2E browser context gets (fixtures.ts):
 *
 * 1. Problems: uncaught page errors, console errors and same-origin 404 / 5xx responses are collected and fail the
 *    test at the end (as the check scripts report them). Refusals the journeys provoke on purpose (401, 403, 409, 410,
 *    422, 429 in the browser console) are expected. Failures that only exist in the Next.js / React development
 *    runtimes (DEV_RUNTIME_FAILURES, seen by scripts/check-portal.mjs under load) are noted on the test instead.
 * 2. Hot reload: the dev server is shared, so another developer's edit would push Fast Refresh updates (or a full
 *    reload) into a page mid-journey. The /_next/webpack-hmr socket stays connected (its pings keep the visited routes
 *    compiled) but the server's messages are dropped. E2E_HMR=1 turns this off.
 */
import type { BrowserContext, Page, Response, TestInfo } from "@playwright/test";
import { BASE_URL } from "./env";

/** Development-runtime failures that cannot happen in a production build (scripts/check-portal.mjs). */
export const DEV_RUNTIME_FAILURES = [/Expected clientReferenceManifest to be defined/, /frame\.join is not a function/];

const EXPECTED_REFUSAL = /status of (401|403|409|410|422|429)\b/;

/** Query values that are tokens (order links, signed downloads) are never written to reports. */
export const redactUrl = (url: string) => url.replace(BASE_URL, "").replace(/([?&](?:t|token|sig|exp|code)=)[^&]+/g, "$1…");

export class Problems {
  readonly list: string[] = [];
  readonly notes: string[] = [];

  constructor(private readonly testInfo: TestInfo) {}

  add(problem: string): void {
    if (DEV_RUNTIME_FAILURES.some((re) => re.test(problem))) {
      this.note(`development-runtime failure (not a product bug): ${problem.slice(0, 200)}`);
      return;
    }
    this.list.push(problem.slice(0, 400));
  }

  note(text: string): void {
    this.notes.push(text);
    this.testInfo.annotations.push({ type: "note", description: text });
  }
}

async function onResponse(problems: Problems, res: Response): Promise<void> {
  const status = res.status();
  if (status !== 404 && status < 500) return;
  const url = new URL(res.url());
  if (url.origin !== BASE_URL) return;
  // Development hot-update manifests can 404 while the dev server compiles another route; they are not app requests.
  if (status === 404 && url.pathname.startsWith("/_next/static/webpack/")) return;
  const line = `${status} ${res.request().method()} ${redactUrl(res.url())}`;
  const body = status >= 500 ? await res.text().catch(() => "") : "";
  if (DEV_RUNTIME_FAILURES.some((re) => re.test(body))) problems.note(`${line}: development-runtime failure (not a product bug)`);
  else problems.add(line);
}

export async function guardContext(context: BrowserContext, problems: Problems): Promise<void> {
  if (process.env.E2E_HMR !== "1") {
    await context.routeWebSocket(/\/_next\/webpack-hmr/, (ws) => {
      const server = ws.connectToServer();
      // Page -> server messages (pings) are still forwarded; server -> page messages (updates, reloads) are dropped.
      server.onMessage(() => undefined);
    });
  }
  context.on("weberror", (error) => problems.add(`pageerror: ${error.error().message}`));
  context.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Failed resources are reported once, with their URL, by the response listener.
    if (EXPECTED_REFUSAL.test(text) || /status of (404|5\d\d)\b/.test(text)) return;
    problems.add(`console: ${text.slice(0, 300)}`);
  });
  context.on("response", (res) => void onResponse(problems, res));
}

/**
 * page.goto that waits for the network to settle (bounded: order pages poll) and, on a development-runtime 500,
 * reloads once and notes it on the test (no hidden retries of anything else).
 */
export async function go(page: Page, path: string, problems?: Problems): Promise<Response | null> {
  let res = await page.goto(path, { waitUntil: "domcontentloaded" });
  if (res && res.status() >= 500) {
    const body = await res.text().catch(() => "");
    if (DEV_RUNTIME_FAILURES.some((re) => re.test(body))) {
      problems?.note(`${redactUrl(res.url())} hit a development-runtime failure; reloaded once`);
      res = await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  return res;
}

/**
 * Requests a route once (with the page's cookies) right before a client-side navigation to it, so the shared dev
 * server has compiled it and keeps it among its recently used routes: an on-demand compile or eviction during the
 * navigation's streamed response is a development-runtime failure, not something the journey tests.
 */
export async function warm(page: Page, path: string): Promise<void> {
  await page.request.get(path, { maxRedirects: 0 }).catch(() => undefined);
}
