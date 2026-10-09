/**
 * Storefront smoke + accessibility crawl (dev tool). Uses the locally installed Google Chrome through Playwright.
 *
 *   node scripts/check-storefront.mjs [--base=http://localhost:3000] [--widths=1280,360] [--only=<substring>]
 *     [--concurrency=3] [--json=<report.json>] [--verbose]
 *
 * Routes: the fixed storefront pages plus every product, guide and legal document listed in /sitemap.xml, the
 * /docs and /legal redirects, an unknown product (404), /compare with two products, the demo form, the purchase and
 * auth pages (/cart, /checkout, /sign-in, /register, /forgot, /reset with a bad token, and /verify as a freshly
 * registered customer), and the non-HTML routes (/sitemap.xml, /robots.txt, /opengraph-image and each page's og:image).
 * The end-to-end purchase journey is checked by scripts/check-purchase.mjs.
 *
 * Every HTML route is loaded at each width and must: answer with the expected status, log no console errors or page
 * errors, have exactly one <h1> and one <main> landmark, a non-empty <title>, valid JSON-LD, no horizontal overflow at
 * widths below 768px, and no axe-core violations for WCAG 2.0 A/AA and 2.1 AA. The header's Software menu is also
 * opened at 1024 and 1280px (checkSoftwareMenu; `--only=menu` runs just that). Exit code 1 when anything fails.
 */
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const BASE = new URL(opt.base ?? process.env.STOREFRONT_BASE_URL ?? "http://localhost:3000").origin;
const WIDTHS = (opt.widths ?? "1280,360").split(",").map(Number).filter((n) => n > 0);
const CONCURRENCY = Math.max(1, Number(opt.concurrency ?? 3));
const VERBOSE = opt.verbose === "true";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const MOBILE_MAX = 767;

/**
 * Route prefixes the storefront links to before a later phase builds them. A production server prefetches visible links,
 * so until they exist their prefetches 404: reported as pending, not as failures. Empty since the customer portal
 * (/account) shipped in Phase 5; add a prefix here while a linked area is still being built.
 * @type {string[]}
 */
const PENDING_ROUTES = [];

function isPendingRoute(url) {
  const { pathname } = new URL(url, BASE);
  return PENDING_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * @typedef {{ path: string, status?: number, redirectTo?: string, kind?: "html" | "xml" | "text" | "image",
 *   session?: "unverified", expectText?: string }} Route
 */

/** @type {Route[]} */
const FIXED_ROUTES = [
  { path: "/" },
  { path: "/software" },
  // 2026-10-09: the coming-soon view of the catalog (coming-soon product pages come from the sitemap).
  { path: "/software?availability=coming-soon", expectText: "Coming soon" },
  { path: "/software/unknown", status: 404 },
  { path: "/compare?ids=medical-billing,cheque-printing" },
  { path: "/pricing" },
  { path: "/about" },
  { path: "/contact" },
  { path: "/contact?type=demo&product=medical-billing" },
  { path: "/support" },
  { path: "/docs", redirectTo: "/docs/" },
  { path: "/legal", redirectTo: "/legal/terms" },
  // Phase 3: cart, checkout and the auth pages (signed out unless `session` is set).
  { path: "/cart" },
  { path: "/checkout" },
  { path: "/sign-in" },
  { path: "/register" },
  { path: "/register?next=%2Faccount%2Fsoftware&trial=medical-billing" },
  // Signed in, the subtitle names the email the code went to (signed out it says "your email").
  { path: "/verify", session: "unverified", expectText: "We sent a 6-digit code to sf-check-" },
  { path: "/forgot" },
  { path: "/reset?token=bad" },
  { path: "/sitemap.xml", kind: "xml" },
  { path: "/robots.txt", kind: "text" },
  { path: "/opengraph-image", kind: "image" },
];

const failures = [];
const pending = new Set();
const report = { base: BASE, widths: WIDTHS, startedAt: new Date().toISOString(), routes: [] };

function fail(route, width, message) {
  failures.push({ route, width, message });
}

/** Paths listed in the sitemap (absolute URLs from APP_URL), mapped onto BASE. */
async function sitemapPaths() {
  const res = await fetch(`${BASE}/sitemap.xml`);
  if (!res.ok) throw new Error(`/sitemap.xml answered ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    const url = new URL(m[1].trim());
    return url.pathname + url.search;
  });
}

async function routeList() {
  const fromSitemap = (await sitemapPaths()).filter((p) => /^\/(software|docs|legal)\/[^/]+$/.test(p));
  const seen = new Set();
  const all = [];
  for (const route of [...FIXED_ROUTES, ...fromSitemap.map((path) => ({ path }))]) {
    if (seen.has(route.path)) continue;
    seen.add(route.path);
    all.push(route);
  }
  return opt.only ? all.filter((r) => r.path.includes(opt.only)) : all;
}

/** Non-HTML routes: status and content type (plus a light content check). */
async function checkResource(route) {
  const res = await fetch(BASE + route.path, { redirect: "manual" });
  const type = res.headers.get("content-type") ?? "";
  const entry = { path: route.path, width: null, status: res.status, contentType: type };
  report.routes.push(entry);
  if (res.status !== (route.status ?? 200)) return fail(route.path, null, `status ${res.status}, expected ${route.status ?? 200}`);
  const expectType = { xml: "xml", text: "text/plain", image: "image/" }[route.kind];
  if (!type.includes(expectType)) fail(route.path, null, `content-type "${type}", expected ${expectType}`);
  if (route.kind === "xml") {
    const body = await res.text();
    entry.urls = (body.match(/<loc>/g) ?? []).length;
    if (!body.includes("<urlset") || entry.urls === 0) fail(route.path, null, "sitemap has no <url> entries");
  } else if (route.kind === "text") {
    const body = await res.text();
    if (!/^Sitemap: /m.test(body) || !/^Disallow: \/account/m.test(body)) fail(route.path, null, "robots.txt lacks Sitemap or Disallow: /account");
  } else if (route.kind === "image") {
    const bytes = (await res.arrayBuffer()).byteLength;
    entry.bytes = bytes;
    if (bytes < 1000) fail(route.path, null, `image is only ${bytes} bytes`);
  }
}

const ogImages = new Set();

/**
 * Signed-in routes (`session: "unverified"`): /verify is checked as a customer who just registered. The crawl
 * registers one throwaway customer (sf-check-<time>@example.test) through the real API and reuses its cookies. The
 * register limit is 5 per hour per IP, and every local request shares one IP bucket while TRUSTED_PROXY_HOPS=0.
 */
const sessions = new Map();

function cookiePairs(res) {
  return res.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  });
}

async function unverifiedSession() {
  const csrfRes = await fetch(`${BASE}/api/csrf`, { cache: "no-store" });
  if (!csrfRes.ok) throw new Error(`/api/csrf answered ${csrfRes.status}`);
  const { token } = await csrfRes.json();
  const jar = new Map(cookiePairs(csrfRes).map((c) => [c.name, c.value]));
  const email = `sf-check-${Date.now().toString(36)}@example.test`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": token,
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    // A throwaway password that is never used again.
    body: JSON.stringify({ name: "Storefront Check", email, password: `Sf${crypto.randomUUID().slice(0, 12)}9x` }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`registering the check customer answered ${res.status}${res.status === 429 ? " (register limit: 5 per hour per IP)" : ""}`);
  }
  for (const c of cookiePairs(res)) jar.set(c.name, c.value);
  if (!jar.get("axs_session")) throw new Error("register did not set the session cookie");
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

async function sessionCookies(kind) {
  if (!sessions.has(kind)) sessions.set(kind, unverifiedSession());
  return sessions.get(kind);
}

/** One HTML route at one width. */
async function checkPage(browser, route, width) {
  const label = `${route.path} @${width}`;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    isMobile: false,
  });
  if (route.session) await context.addCookies(await sessionCookies(route.session));
  const page = await context.newPage();
  const consoleErrors = [];
  const badResponses = [];
  const expected404 = route.status === 404;
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const source = msg.location()?.url ?? "";
    // The browser logs the document's own expected 404, and the 404s of prefetched pending routes.
    if (expected404 && /status of 404/.test(text)) return;
    if (/status of 404/.test(text) && source && isPendingRoute(source)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("response", (res) => {
    const status = res.status();
    if (status < 400) return;
    if (expected404 && res.request().isNavigationRequest()) return;
    if (status === 404 && isPendingRoute(res.url())) {
      pending.add(new URL(res.url()).pathname);
      return;
    }
    badResponses.push(`${status} ${res.url().replace(BASE, "")}`);
  });

  const entry = { path: route.path, width, status: null, violations: [] };
  report.routes.push(entry);
  try {
    const response = await page.goto(BASE + route.path, { waitUntil: "load", timeout: 120_000 });
    // Prefetches of pending routes leave unread 404 bodies open, so network idle may never come: wait briefly.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    entry.status = response?.status() ?? null;
    entry.finalPath = new URL(page.url()).pathname + new URL(page.url()).search;

    const expected = route.status ?? 200;
    if (entry.status !== expected) fail(route.path, width, `status ${entry.status}, expected ${expected}`);
    if (route.session && new URL(page.url()).pathname !== new URL(route.path, BASE).pathname) {
      fail(route.path, width, `expected to stay on ${route.path} as a signed-in (${route.session}) user, ended at ${entry.finalPath}`);
    }
    if (route.redirectTo) {
      const redirected = response?.request().redirectedFrom() != null;
      if (!redirected || !entry.finalPath.startsWith(route.redirectTo)) {
        fail(route.path, width, `expected a redirect to ${route.redirectTo}*, ended at ${entry.finalPath}`);
      }
    }

    const facts = await page.evaluate(() => {
      const doc = document.documentElement;
      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try {
          JSON.parse(s.textContent ?? "");
          return null;
        } catch (error) {
          return String(error);
        }
      });
      return {
        h1: document.querySelectorAll("h1").length,
        main: document.querySelectorAll("main, [role='main']").length,
        title: document.title.trim(),
        text: document.body.innerText,
        overflow: doc.scrollWidth - doc.clientWidth,
        jsonLdErrors: jsonLd.filter(Boolean),
        jsonLdCount: jsonLd.length,
        ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null,
      };
    });
    Object.assign(entry, { h1: facts.h1, main: facts.main, title: facts.title, overflow: facts.overflow, jsonLd: facts.jsonLdCount });
    if (route.expectText && !facts.text.includes(route.expectText)) fail(route.path, width, `page text lacks "${route.expectText}"`);
    if (facts.h1 !== 1) fail(route.path, width, `${facts.h1} <h1> elements, expected exactly 1`);
    if (facts.main !== 1) fail(route.path, width, `${facts.main} main landmarks, expected exactly 1`);
    if (!facts.title) fail(route.path, width, "empty <title>");
    if (facts.jsonLdErrors.length) fail(route.path, width, `invalid JSON-LD: ${facts.jsonLdErrors.join("; ")}`);
    if (width <= MOBILE_MAX && facts.overflow > 0) fail(route.path, width, `horizontal overflow of ${facts.overflow}px`);
    // Share images of real pages only (a 404 page keeps its segment's file-based og:image).
    if (facts.ogImage && entry.status === 200) {
      const og = new URL(facts.ogImage);
      ogImages.add(og.pathname + og.search);
    }

    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    entry.violations = axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
    for (const v of entry.violations) {
      fail(route.path, width, `axe ${v.id} (${v.impact}, ${v.nodes} node${v.nodes === 1 ? "" : "s"}): ${v.help} -> ${v.targets.join(" | ")}`);
    }
  } catch (error) {
    fail(route.path, width, `crashed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    entry.consoleErrors = consoleErrors;
    entry.badResponses = badResponses;
    for (const message of consoleErrors) fail(route.path, width, `console error: ${message.slice(0, 300)}`);
    for (const message of badResponses) fail(route.path, width, `request failed: ${message}`);
    await context.close();
    if (VERBOSE) console.info(`checked ${label}`);
  }
}

/**
 * The header's Software menu (design C, decisions.md 2026-10-09), opened at each MENU_WIDTHS width on /pricing: the
 * panel stays inside the viewport, the page does not scroll sideways, the "Coming soon" directory lists the seeded
 * coming-soon products and names each link "<product>, coming soon", and axe passes with the menu open.
 */
const MENU_LABEL = "Software menu";
const MENU_WIDTHS = [1024, 1280];
const MENU_CHECK = !opt.only || opt.only === "menu";

async function checkSoftwareMenu(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce", isMobile: false });
  const page = await context.newPage();
  const entry = { path: MENU_LABEL, width, status: null, violations: [] };
  report.routes.push(entry);
  try {
    const response = await page.goto(`${BASE}/pricing`, { waitUntil: "load", timeout: 120_000 });
    entry.status = response?.status() ?? null;
    const selector = "#site-header nav button[aria-controls]";
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
      },
      selector,
      { timeout: 60_000 },
    );
    const trigger = page.locator(selector, { hasText: "Software" }).first();
    await trigger.click();
    const menu = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(300);
    const facts = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const doc = document.documentElement;
      return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: doc.clientWidth, vh: window.innerHeight, overflow: doc.scrollWidth - doc.clientWidth };
    });
    Object.assign(entry, { menu: facts });
    if (facts.left < 0 || facts.right > facts.vw || facts.bottom > facts.vh) {
      fail(MENU_LABEL, width, `the open menu leaves the viewport: x ${facts.left}..${facts.right} of ${facts.vw}px, bottom ${facts.bottom} of ${facts.vh}px`);
    }
    if (facts.overflow > 0) fail(MENU_LABEL, width, `horizontal overflow of ${facts.overflow}px with the menu open`);
    const soon = menu.getByRole("group", { name: "Coming soon", exact: true });
    const all = await soon.locator("a[href^='/software/']").count();
    const named = await soon.getByRole("link", { name: /, coming soon$/ }).count();
    entry.comingSoonLinks = all;
    if (all === 0) fail(MENU_LABEL, width, 'no links in the "Coming soon" directory (the seed has coming-soon products)');
    if (named !== all) fail(MENU_LABEL, width, `${all - named} of ${all} coming-soon links lack "coming soon" in their accessible name`);
    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    entry.violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
    for (const v of entry.violations) fail(MENU_LABEL, width, `axe ${v.id} (${v.impact}, ${v.nodes} nodes): ${v.help} -> ${v.targets.join(" | ")}`);
  } catch (error) {
    fail(MENU_LABEL, width, `crashed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await context.close();
    if (VERBOSE) console.info(`checked ${MENU_LABEL} @${width}`);
  }
}

async function pool(items, size, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await worker(item);
    }),
  );
}

const routes = await routeList();
const htmlRoutes = routes.filter((r) => !r.kind);
console.info(`Checking ${htmlRoutes.length} pages x ${WIDTHS.length} widths and ${routes.length - htmlRoutes.length} resources on ${BASE}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // Warm-up (a dev server compiles each route on first request), one page at a time.
  for (const route of htmlRoutes) await fetch(BASE + route.path).catch(() => {});
  const jobs = htmlRoutes.flatMap((route) => WIDTHS.map((width) => ({ route, width })));
  await pool(jobs, CONCURRENCY, ({ route, width }) => checkPage(browser, route, width));
  if (MENU_CHECK) for (const width of MENU_WIDTHS) await checkSoftwareMenu(browser, width);
} finally {
  await browser.close();
}
for (const route of routes.filter((r) => r.kind)) await checkResource(route);
for (const path of [...ogImages].sort()) {
  if (path === "/opengraph-image" || routes.some((r) => r.path === path)) continue;
  await checkResource({ path, kind: "image" });
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
report.pendingRoutes = [...pending].sort();
if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2));

// Summary: one line per route and width, then every failure.
const byKey = new Map();
for (const f of failures) {
  const key = `${f.route}${f.width ? ` @${f.width}` : ""}`;
  byKey.set(key, [...(byKey.get(key) ?? []), f.message]);
}
for (const entry of report.routes) {
  const key = `${entry.path}${entry.width ? ` @${entry.width}` : ""}`;
  const problems = byKey.get(key) ?? [];
  console.info(`${problems.length ? "FAIL" : "ok  "} ${String(entry.status).padEnd(4)} ${key}`);
  for (const message of problems) console.info(`       - ${message}`);
}
if (pending.size) console.info(`\nPending routes linked from the storefront (404 until built): ${[...pending].sort().join(", ")}`);
const violationCount = report.routes.reduce((n, r) => n + (r.violations?.length ?? 0), 0);
console.info(
  `\n${report.routes.length} checks, ${failures.length} failure${failures.length === 1 ? "" : "s"} (${violationCount} axe violation group${violationCount === 1 ? "" : "s"}).`,
);
process.exit(failures.length ? 1 : 0);
