/**
 * Customer portal check (dev tool). Drives the real app in the locally installed Google Chrome (Playwright, channel
 * "chrome") as the three Sharma Medicals demo members, each signed in through the /sign-in form: Priya (Owner),
 * Rohan (Billing admin) and Kavya (Technical contact).
 *
 *   node scripts/check-portal.mjs [--base=http://localhost:3000] [--only=pages,owner,billing,technical]
 *     [--roles=owner,billing,technical] [--widths=1280,360] [--concurrency=3] [--shots=<dir>] [--json=<file>]
 *     [--keep-data] [--keep-limits] [--verbose]
 *
 *   pages      Every /account route for each role at each width: HTTP 200 (Team and Activity log show the
 *              permission-denied panel to non-owners), no console errors, page errors or 5xx responses, no horizontal
 *              overflow, exactly one <h1> and one <main>, and no axe-core violations (WCAG 2.0 A/AA and 2.1 AA).
 *              A page that hits one of the Next.js / React development-runtime failures in DEV_RUNTIME_FAILURES (code
 *              that only exists in development builds) is checked again once and reported as a note.
 *   owner      Priya: reveal a key (wrong, then right password; Hide), activate a throwaway device through the
 *              activation API, rename it, move it to a location and deactivate it (confirmation), add a renewal to the
 *              cart from the Renew & upgrade tab, edit the billing details (then restore them), create a ticket with
 *              an attachment, reply, resolve and reopen it, invite a teammate and accept the invitation in a fresh
 *              browser context from the /dev/mailbox link, change their role, remove them, export the activity CSV,
 *              change a notification preference (then restore it) and sign out all other sessions (so Priya is
 *              signed out of every other browser too).
 *   billing    Rohan: Reveal, Deactivate and the download buttons are disabled and their APIs answer 403; the billing
 *              details can be edited (then restored); Team and Activity log are not in the navigation.
 *   technical  Kavya: downloads an installer and reveals a key; the billing form is read-only and its API answers
 *              403; Team and Activity log are not in the navigation and their APIs answer 403.
 *
 * Needs a development server with EMAIL_TRANSPORT=console (the invitation is read from /dev/mailbox), the seeded demo
 * data (`pnpm db:seed`, SEED_DEMO_PASSWORD in .env.local) and DATABASE_URL in .env.local. With TRUSTED_PROXY_HOPS=0
 * every local request shares the "unknown" IP rate-limit buckets, so the script first deletes those rows (local
 * servers only; --keep-limits skips it). Afterwards it removes what the journeys created on the demo account (the
 * throwaway device and its license events, the ticket with its messages and uploaded files, the invited user, and the
 * account activity and download events written during the run) and restores the yearly deactivation counter, unless
 * --keep-data (local servers only). Never prints passwords, keys, codes or tokens. Exit code 1 when any check fails.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, request as playwrightRequest } from "@playwright/test";
import pg from "pg";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const BASE = new URL(opt.base ?? process.env.PORTAL_BASE_URL ?? "http://localhost:3000").origin;
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname);
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = new Set(list(opt.only ?? "pages,owner,billing,technical"));
const ROLES = list(opt.roles ?? "owner,billing,technical");
const WIDTHS = list(opt.widths ?? "1280,360").map(Number).filter((n) => n > 0);
const CONCURRENCY = Math.max(1, Number(opt.concurrency ?? 3));
const SHOTS = opt.shots ? path.resolve(opt.shots) : null;
const KEEP_DATA = opt["keep-data"] === "true";
const VERBOSE = opt.verbose === "true";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const TAG = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const KEY_RE = /^[A-Z]{3}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const DENIED = "You don’t have access to";
// API refusals the journeys provoke on purpose (wrong password 422, role checks 403) are logged by the browser.
const EXPECTED_REFUSAL = /status of (401|403|422)\b/;

const USERS = {
  owner: { email: "priya@sharmamedicals.example", label: "Priya (Owner)" },
  billing: { email: "rohan@sharmamedicals.example", label: "Rohan (Billing admin)" },
  technical: { email: "kavya@sharmamedicals.example", label: "Kavya (Technical contact)" },
};

/** Reads KEY=value lines of .env.local (multi-line PEM values are skipped). Values are never printed. */
function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return env;
}
const ENV = readEnv();
const PASSWORD = ENV.SEED_DEMO_PASSWORD ?? "";
if (!PASSWORD) {
  console.error("SEED_DEMO_PASSWORD is missing from .env.local.");
  process.exit(2);
}

const results = [];
let current = "setup";
function check(ok, label, detail) {
  results.push({ scenario: current, ok: Boolean(ok), label, detail: ok ? undefined : detail });
  if (!ok || VERBOSE) console.info(`${ok ? "PASS" : "FAIL"} [${current}] ${label}${!ok && detail !== undefined ? ` -> ${String(detail).slice(0, 600)}` : ""}`);
  return Boolean(ok);
}

// ---------- database (fixtures, read-only checks, local clean-up) ----------
const db = new pg.Client({ connectionString: (ENV.DATABASE_URL ?? "").replace(/\?.*$/, "") });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] ?? null;
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

/** Deletes the shared "unknown"-IP buckets (TRUSTED_PROXY_HOPS=0 in development), local servers only. */
async function resetSharedIpBuckets() {
  if (!LOCAL || opt["keep-limits"] === "true") return;
  const unknown = createHash("sha256").update("unknown").digest("hex").slice(0, 32);
  const res = await db.query(`DELETE FROM "RateLimitBucket" WHERE "key" LIKE $1`, [`%:ip:${unknown}`]);
  console.info(`Cleared ${res.rowCount} shared local rate-limit bucket(s).`);
}

/** Seed objects the checks use, looked up rather than hard-coded where the seed allows. */
async function loadFixtures() {
  const owner = await one(
    `SELECT m."accountId", a."legalName" FROM "AccountMember" m JOIN "User" u ON u.id = m."userId"
       JOIN "BusinessAccount" a ON a.id = m."accountId"
      WHERE u.email = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE' ORDER BY m."createdAt" LIMIT 1`,
    [USERS.owner.email],
  );
  if (!owner) throw new Error(`${USERS.owner.email} owns no business account: run the seed (pnpm db:seed).`);
  const accountId = owner.accountId;
  const activeDevices = `(SELECT count(*)::int FROM "DeviceActivation" d WHERE d."licenseId" = l.id AND d."deactivatedAt" IS NULL)`;
  // A usable license with active devices, preferably one that expires (it has a RENEWAL option): pages, role checks.
  const withDevices = await one(
    `SELECT l.id FROM "License" l WHERE l."accountId" = $1 AND l.status = 'ACTIVE'
        AND (l."expiresAt" IS NULL OR l."expiresAt" > now()) AND ${activeDevices} > 0
      ORDER BY (l."expiresAt" IS NULL), l.id LIMIT 1`,
    [accountId],
  );
  // A usable license with a free slot and a deactivation left this year (the throwaway device).
  const spare = await one(
    `SELECT l.id, p.code, l."selfServiceResets", l."resetsYear" FROM "License" l JOIN "Product" p ON p.id = l."productId"
      WHERE l."accountId" = $1 AND l.status = 'ACTIVE' AND (l."expiresAt" IS NULL OR l."expiresAt" > now())
        AND ${activeDevices} < l."deviceLimit" AND (l."resetsYear" <> extract(year FROM now() AT TIME ZONE 'Asia/Kolkata') OR l."selfServiceResets" < 3)
      ORDER BY (l.id = 'LIC-24212') DESC, l.id LIMIT 1`,
    [accountId],
  );
  const device = withDevices
    ? await one(`SELECT id, name FROM "DeviceActivation" WHERE "licenseId" = $1 AND "deactivatedAt" IS NULL ORDER BY "activatedAt" LIMIT 1`, [withDevices.id])
    : null;
  const ticket = await one(`SELECT id FROM "SupportTicket" WHERE "accountId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [accountId]);
  const releaseFile = await one(
    `SELECT f.id FROM "ReleaseFile" f JOIN "Release" r ON r.id = f."releaseId"
      WHERE r.status = 'PUBLISHED' AND r.channel = 'stable' AND r."productId" IN (SELECT "productId" FROM "License" WHERE "accountId" = $1)
      ORDER BY r."releasedAt" DESC NULLS LAST LIMIT 1`,
    [accountId],
  );
  const locations = await all(`SELECT id, name FROM "Location" WHERE "accountId" = $1 ORDER BY name`, [accountId]);
  const members = await all(
    `SELECT u.id, u.email FROM "AccountMember" m JOIN "User" u ON u.id = m."userId" WHERE m."accountId" = $1`,
    [accountId],
  );
  return { accountId, accountName: owner.legalName, withDevices: withDevices?.id ?? null, spare, device, ticket: ticket?.id ?? null, releaseFile: releaseFile?.id ?? null, locations, members };
}

// ---------- browser ----------
let browser;
const STATES = {};

/** A context at `width`, signed in as `role` (storage state from the UI sign-in) or signed out. */
async function open({ role = null, width = 1280, downloads = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    acceptDownloads: downloads,
    ...(role ? { storageState: STATES[role] } : {}),
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  // A failed resource is reported once, with its URL (the browser's console line has none): 404s and 5xx.
  page.on("console", (msg) => {
    if (msg.type() !== "error" || EXPECTED_REFUSAL.test(msg.text()) || /status of (404|5[0-9][0-9])/.test(msg.text())) return;
    problems.push(`console: ${msg.text().slice(0, 300)}`);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status !== 404 && status < 500) return;
    // Development hot-update manifests can 404 while the dev server compiles another route; they are not app requests.
    if (status === 404 && new URL(res.url()).pathname.includes("/_next/static/webpack/")) return;
    problems.push(`${status} ${res.request().method()} ${res.url().replace(BASE, "").replace(/([?&](?:t|token|sig|exp)=)[^&]+/g, "$1…")}`);
  });
  return { ctx, page, problems };
}

async function close({ ctx, problems }, label) {
  check(problems.length === 0, `${label}: no page errors, console errors, 404s or 5xx responses`, problems.join(" | "));
  await ctx.close();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // License keys render in <code>: masked so a screenshot never stores a full key.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, mask: [page.locator("code")] }).catch(() => {});
}

async function go(page, pathname) {
  const res = await page.goto(BASE + pathname, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  return res;
}

const visible = (locator) => locator.filter({ visible: true }).first();
const toasts = (page) => page.locator("[data-sonner-toast]").allInnerTexts();
async function waitForToast(page, text, timeout = 20_000) {
  const toast = page.locator("[data-sonner-toast]", { hasText: text }).first();
  return toast.waitFor({ timeout }).then(() => true, () => false);
}

/** Calls an API from the page (same origin, CSRF token from GET /api/csrf); resolves to the HTTP status. */
async function apiStatus(page, method, url, body) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const headers = {};
      if (method !== "GET") {
        const csrf = await (await fetch("/api/csrf", { cache: "no-store" })).json();
        headers["x-csrf-token"] = csrf.token;
        if (body !== undefined) headers["content-type"] = "application/json";
      }
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
      return res.status;
    },
    { method, url, body },
  );
}

/** "disabled" (aria-disabled or disabled), "enabled" or "absent" for the first visible match. */
async function actionState(locator) {
  const target = locator.filter({ visible: true });
  if ((await target.count()) === 0) return "absent";
  const el = target.first();
  const disabled = (await el.getAttribute("aria-disabled")) === "true" || (await el.isDisabled().catch(() => false));
  return disabled ? "disabled" : "enabled";
}

/** Names of the links in the portal navigation ("Account" nav) of the desktop sidebar. */
async function navLinks(page) {
  return page.locator("nav[aria-label='Account'] a").filter({ visible: true }).allInnerTexts().then((names) => names.map((n) => n.replace(/\s+/g, " ").trim()));
}

/** Signs in through the /sign-in form and keeps the context's storage state (cookies) for every later context. */
async function signInViaUi(role) {
  current = `sign-in ${role}`;
  const s = await open({ width: 1280 });
  const { page } = s;
  try {
    await go(page, `/sign-in?next=${encodeURIComponent("/account")}`);
    // Typing before React hydrates the form makes dev builds log a hydration mismatch; wait until React owns it.
    await page.waitForFunction(() => {
      const el = document.querySelector("#sign-in-email");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    }, undefined, { timeout: 60_000 });
    await page.locator("#sign-in-email").fill(USERS[role].email);
    await page.locator("#sign-in-password").fill(PASSWORD);
    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname === "/account", { timeout: 90_000 }),
      page.locator("main form").getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    await page.locator("h1").first().waitFor({ timeout: 60_000 });
    check(true, `${USERS[role].label} signs in through /sign-in and lands on /account`);
    STATES[role] = await s.ctx.storageState();
  } catch (error) {
    check(false, `${USERS[role].label} signs in through /sign-in and lands on /account`, error instanceof Error ? error.message : String(error));
    await shot(page, `sign-in-${role}-failure`);
  } finally {
    await close(s, `sign-in ${role}`);
  }
}

// ---------- /dev/mailbox ----------
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** Messages in the dev mailbox, newest first: { id, subject, to }. */
async function mailbox() {
  const html = await (await fetch(`${BASE}/dev/mailbox`)).text();
  const re = /href="\/dev\/mailbox\?id=([^"]+)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => ({ id: decode(m[1]), subject: decode(m[2]), to: decode(m[3]) }));
}

async function waitForMail(to, subjectRe, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await mailbox()).find((m) => m.to === to && subjectRe.test(m.subject));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} matching ${subjectRe}`);
}

// ---------- pages ----------
/**
 * `ownerOnly`: other roles see the permission-denied panel. `expect`: text the page must contain. Licenses and the
 * ticket come from the seed (fixtures); the unknown URL renders the in-shell not-found page.
 */
function pageRoutes(fx) {
  const lic = fx.withDevices;
  return [
    { path: "/account" },
    { path: "/account/software" },
    { path: "/account/licenses" },
    ...(lic
      ? [
          { path: `/account/licenses/${lic}` },
          { path: `/account/licenses/${lic}?tab=devices` },
          { path: `/account/licenses/${lic}?tab=activity` },
          { path: `/account/licenses/${lic}?tab=renew` },
        ]
      : []),
    { path: "/account/devices" },
    { path: "/account/orders" },
    { path: "/account/billing" },
    { path: "/account/team", ownerOnly: true },
    { path: "/account/tickets" },
    { path: "/account/tickets/new" },
    ...(fx.ticket ? [{ path: `/account/tickets/${fx.ticket}` }] : []),
    { path: "/account/notifications" },
    { path: "/account/activity", ownerOnly: true },
    { path: "/account/security" },
    { path: "/account/no-such-page", expect: "not found", widths: [1280] },
  ];
}

const report = { base: BASE, startedAt: new Date().toISOString(), pages: [] };

/**
 * Failures of the Next.js / React development runtimes, seen intermittently under the crawl's load and impossible in a
 * production build: the "clientReferenceManifest" invariant (a 500 while the dev server recompiles a route it had
 * evicted) and React's dev-only RSC debug-stack replay (buildFakeCallStack) receiving a malformed frame.
 */
const DEV_RUNTIME_FAILURES = [/Expected clientReferenceManifest to be defined/, /frame\.join is not a function/];

/**
 * One route as one role at one width. Returns "retry" (and records nothing) on the first attempt when the page hit a
 * DEV_RUNTIME_FAILURES error.
 */
async function checkPage(role, route, width, attempt = 1) {
  const label = `${route.path} as ${role} @${width}`;
  let retry = false;
  const s = await open({ role, width });
  const { page } = s;
  const entry = { role, path: route.path, width, status: null, violations: [] };
  report.pages.push(entry);
  try {
    const res = await go(page, route.path);
    await page.locator("main h1").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(250);
    entry.status = res?.status() ?? null;
    if (attempt === 1 && s.problems.some((p) => DEV_RUNTIME_FAILURES.some((re) => re.test(p)))) {
      retry = true;
      return "retry";
    }
    entry.finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
    check(entry.status === 200, `${label}: HTTP 200`, `status ${entry.status}`);
    check(new URL(page.url()).pathname === new URL(route.path, BASE).pathname, `${label}: stays on the page`, `ended at ${entry.finalPath}`);
    const facts = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        h1: document.querySelectorAll("h1").length,
        main: document.querySelectorAll("main, [role='main']").length,
        title: document.title.trim(),
        text: document.body.innerText,
        overflow: doc.scrollWidth - doc.clientWidth,
      };
    });
    Object.assign(entry, { h1: facts.h1, main: facts.main, title: facts.title, overflow: facts.overflow });
    check(facts.h1 === 1, `${label}: exactly one <h1>`, `${facts.h1} <h1> elements`);
    check(facts.main === 1, `${label}: exactly one main landmark`, `${facts.main} main landmarks`);
    check(facts.title.length > 0, `${label}: non-empty <title>`);
    check(facts.overflow <= 0, `${label}: no horizontal overflow`, `${facts.overflow}px`);
    const denied = facts.text.includes(DENIED);
    if (route.ownerOnly) {
      check(denied === (role !== "owner"), `${label}: ${role === "owner" ? "opens" : "shows the permission-denied panel"}`, denied ? "denied panel shown" : "page content shown");
    } else {
      check(!denied, `${label}: no permission-denied panel`);
    }
    if (route.expect) check(facts.text.toLowerCase().includes(route.expect), `${label}: shows "${route.expect}"`);
    check(!/Something went wrong|We can.t load your account|We couldn.t load this page/i.test(facts.text), `${label}: no error state`);
    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    entry.violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
    check(entry.violations.length === 0, `${label}: no axe violations`, entry.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes}): ${v.help} -> ${v.targets.join(" | ")}`).join(" || "));
    if (entry.violations.length || facts.overflow > 0) await shot(page, `page-${role}-${width}-${route.path.replace(/[^a-z0-9]+/gi, "_")}`);
  } catch (error) {
    check(false, `${label}: loads`, error instanceof Error ? error.message : String(error));
  } finally {
    if (retry) {
      report.pages.splice(report.pages.indexOf(entry), 1);
      await s.ctx.close();
    } else {
      entry.problems = [...s.problems];
      await close(s, label);
    }
  }
  return "done";
}

async function pool(items, size, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await worker(item);
    }),
  );
}

async function runPages(fx) {
  current = "pages";
  const routes = pageRoutes(fx);
  // Warm-up (a dev server compiles each route on first request), one page at a time.
  const warm = await open({ role: ROLES.includes("owner") ? "owner" : ROLES[0] });
  for (const route of routes) await go(warm.page, route.path).catch(() => {});
  await warm.ctx.close();
  // Route by route (every role and width together), so the dev server compiles each route once while it is in use.
  const roles = ROLES.filter((r) => STATES[r]);
  const jobs = routes.flatMap((route) =>
    roles.flatMap((role) => (route.widths ?? WIDTHS).filter((w) => WIDTHS.includes(w)).map((width) => ({ role, route, width }))),
  );
  console.info(`Checking ${jobs.length} page loads (${routes.length} routes, ${ROLES.length} roles, widths ${WIDTHS.join("/")})`);
  await pool(jobs, CONCURRENCY, async ({ role, route, width }) => {
    if ((await checkPage(role, route, width)) !== "retry") return;
    console.info(`note: ${route.path} as ${role} @${width} hit a Next.js/React development-runtime failure; checked again`);
    await checkPage(role, route, width, 2);
  });
}

// ---------- journeys ----------
const created = { deviceIds: [], ticketIds: [], inviteEmail: null };

/** License key card: Reveal (optionally a wrong password first), check the full key, Hide. Returns the key (memory only). */
async function revealKey(page, licenseId, { wrongFirst = false } = {}) {
  await go(page, `/account/licenses/${licenseId}`);
  const card = page.locator("section", { has: page.getByRole("heading", { name: "License key", exact: true }) });
  await card.getByRole("button", { name: "Reveal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  await dialog.waitFor();
  const submit = async (password) => {
    await dialog.getByLabel("Password").fill(password);
    const res = page.waitForResponse((r) => r.url().endsWith(`/api/account/licenses/${licenseId}/reveal`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Reveal key" }).click();
    return (await res).status();
  };
  if (wrongFirst) {
    const status = await submit(`Wrong-${randomBytes(4).toString("hex")}9`);
    check(status === 422, "a wrong password is refused (422)", `status ${status}`);
    const alert = (await dialog.getByRole("alert").innerText().catch(() => "")).trim();
    check(alert === "Incorrect password.", "the dialog says \"Incorrect password.\"", alert);
  }
  const status = await submit(PASSWORD);
  check(status === 200, "the right password reveals the key (200)", `status ${status}`);
  await dialog.waitFor({ state: "hidden" });
  const code = card.locator("code");
  const key = (await code.innerText()).trim();
  check(KEY_RE.test(key), "the full license key is shown");
  await card.getByRole("button", { name: "Hide", exact: true }).click();
  const masked = (await code.innerText()).trim();
  check(masked !== key && !KEY_RE.test(masked), "Hide masks the key again");
  return key;
}

/** Activates a throwaway device on the license through the public activation API; returns its row id. */
async function activateTestDevice(key, productCode, name) {
  const res = await fetch(`${BASE}/api/v1/licenses/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-id": productCode },
    body: JSON.stringify({ licenseKey: key, deviceFingerprint: randomBytes(32).toString("hex"), deviceName: name, os: "Windows 11 Pro", appVersion: "4.2.1" }),
  });
  check(res.status === 200 || res.status === 201, "a throwaway device activates through the activation API", `status ${res.status}`);
  const row = await one(`SELECT id FROM "DeviceActivation" WHERE name = $1 ORDER BY "activatedAt" DESC LIMIT 1`, [name]);
  if (row) created.deviceIds.push(row.id);
  return row?.id ?? null;
}

async function deviceJourney(page, fx, key) {
  const name = `Portal check PC ${TAG}`;
  const renamed = `${name} renamed`;
  const deviceId = await activateTestDevice(key, fx.spare.code, name);
  if (!deviceId) return;
  await go(page, `/account/licenses/${fx.spare.id}?tab=devices`);
  await visible(page.getByRole("button", { name: `Rename ${name}`, exact: true })).click();
  const rename = page.getByRole("dialog", { name: "Rename device" });
  await rename.getByLabel("Device name").fill(renamed);
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  check(await waitForToast(page, "Device renamed"), "Rename shows \"Device renamed\"", await toasts(page));
  await rename.waitFor({ state: "hidden" });
  check((await one(`SELECT name FROM "DeviceActivation" WHERE id = $1`, [deviceId]))?.name === renamed, "the new device name is saved");

  const target = fx.locations[0];
  if (target) {
    // Row selects are listboxes (arrow keys browse, Enter or a click chooses): open it, then pick the option.
    const select = visible(page.getByRole("combobox", { name: `Location for ${renamed}`, exact: true }));
    await select.waitFor({ timeout: 20_000 });
    await select.click();
    await page.getByRole("option", { name: target.name, exact: true }).click();
    check(await waitForToast(page, `moved to ${target.name}`), `moving the device shows "… moved to ${target.name}"`, await toasts(page));
    check((await one(`SELECT "locationId" FROM "DeviceActivation" WHERE id = $1`, [deviceId]))?.locationId === target.id, "the device's location is saved");
  } else {
    check(false, "the account has a location to move the device to", "no Location rows");
  }

  await visible(page.getByRole("button", { name: `Deactivate ${renamed}`, exact: true })).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.waitFor();
  check(/deactivat/i.test(await confirm.innerText()), "Deactivate asks for confirmation");
  await confirm.getByRole("button", { name: "Deactivate", exact: true }).click();
  await confirm.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
  const row = await one(`SELECT "deactivatedAt", "deactivatedBy" FROM "DeviceActivation" WHERE id = $1`, [deviceId]);
  check(row?.deactivatedAt != null && row?.deactivatedBy === "customer", "the device is deactivated by the customer", JSON.stringify(row));
  await shot(page, "owner-device-deactivated");
}

async function renewalJourney(page, fx) {
  await go(page, `/account/licenses/${fx.withDevices}?tab=renew`);
  const card = page.locator("main section", { has: page.locator("span", { hasText: /^RENEWAL$/ }) }).first();
  await card.getByRole("button", { name: "Add to cart", exact: true }).click();
  await page.waitForURL((url) => new URL(url).pathname === "/cart", { timeout: 30_000 });
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem("axiomatic.cart") ?? "null")?.items ?? []);
  check(
    items.some((i) => i.kind === "RENEWAL" && i.targetLicenseId === fx.withDevices),
    `Renew & upgrade adds a RENEWAL line for ${fx.withDevices} and opens the cart`,
    JSON.stringify(items.map((i) => ({ kind: i.kind, target: i.targetLicenseId, planId: i.planId }))),
  );
  await page.locator("main").getByText(fx.withDevices).first().waitFor({ timeout: 30_000 }).then(
    () => check(true, "the cart shows the renewal line"),
    () => check(false, "the cart shows the renewal line"),
  );
  // Leave the cart as it was.
  await page.evaluate(() => localStorage.removeItem("axiomatic.cart"));
}

/** Billing: change the registered address, save, reload, check, then restore the original and save again. */
async function billingJourney(page) {
  await go(page, "/account/billing");
  const address = page.getByLabel("Registered address");
  const original = await address.inputValue();
  const changed = `${original.replace(/ \(portal check\)$/, "")} (portal check)`;
  const save = async (value, label) => {
    await address.fill(value);
    const res = page.waitForResponse((r) => r.url().endsWith("/api/account/billing") && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save details", exact: true }).click();
    const status = (await res).status();
    check(status === 200, `${label}: PATCH /api/account/billing answers 200`, `status ${status}`);
    check(await waitForToast(page, "Billing details saved"), `${label}: "Billing details saved"`, await toasts(page));
  };
  await save(changed, "billing edit");
  await go(page, "/account/billing");
  check((await page.getByLabel("Registered address").inputValue()) === changed, "the edited address is kept after a reload");
  await save(original, "billing restore");
}

// A 1x1 PNG for the ticket attachment.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function ticketJourney(page) {
  await go(page, "/account/tickets/new");
  await page.getByLabel("Subject").fill(`Portal check ${TAG}: invoices print blank`);
  await page.getByLabel("Low").check();
  await page.getByLabel("Describe the problem").fill("Every invoice prints as a blank page on the counter printer since this morning.");
  await page.locator("input[type=file]").setInputFiles([{ name: "blank-print.png", mimeType: "image/png", buffer: PNG }]);
  await page.waitForFunction(() => !document.querySelector("[role=progressbar]"), null, { timeout: 30_000 });
  check(/blank-print\.png/.test(await page.locator("main form").innerText()), "the screenshot uploads and is listed");
  await Promise.all([
    page.waitForURL(/\/account\/tickets\/T-\d+$/, { timeout: 30_000 }),
    page.getByRole("button", { name: "Submit ticket", exact: true }).click(),
  ]);
  const ticketId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
  created.ticketIds.push(ticketId);
  check(/^T-\d+$/.test(ticketId), `Submit ticket opens the new ticket (${ticketId})`);
  const attached = await one(
    `SELECT count(*)::int AS n FROM "Upload" u JOIN "TicketMessage" m ON m.id = u."ticketMessageId" WHERE m."ticketId" = $1 AND u.status = 'ATTACHED'`,
    [ticketId],
  );
  check(attached?.n === 1, "the attachment is attached to the first message", JSON.stringify(attached));

  const reply = `Adding the printer model (${TAG}).`;
  await page.getByLabel("Reply").fill(reply);
  const sent = page.waitForResponse((r) => r.url().endsWith(`/api/account/tickets/${ticketId}/messages`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  const sentStatus = (await sent).status();
  check(sentStatus === 200 || sentStatus === 201, "Send reply is accepted", `status ${sentStatus}`);
  check(await waitForToast(page, "Reply sent"), "\"Reply sent\" toast", await toasts(page));
  await page.locator("section[aria-label=Conversation]").getByText(reply).first().waitFor({ timeout: 30_000 }).then(
    () => check(true, "the reply is in the conversation"),
    () => check(false, "the reply is in the conversation"),
  );
  check((await one(`SELECT count(*)::int AS n FROM "TicketMessage" WHERE "ticketId" = $1`, [ticketId]))?.n === 2, "the ticket has two messages");

  const resolved = page.waitForResponse((r) => r.url().endsWith(`/api/account/tickets/${ticketId}/status`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Mark resolved", exact: true }).click();
  check((await resolved).status() === 200, "Mark resolved is accepted");
  await page.getByText("This ticket is resolved.").waitFor({ timeout: 30_000 }).then(
    () => check(true, "Mark resolved shows \"This ticket is resolved.\""),
    () => check(false, "Mark resolved shows \"This ticket is resolved.\""),
  );
  check((await one(`SELECT status FROM "SupportTicket" WHERE id = $1`, [ticketId]))?.status === "RESOLVED", "the ticket is RESOLVED");
  const reopened = page.waitForResponse((r) => r.url().endsWith(`/api/account/tickets/${ticketId}/status`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  check((await reopened).status() === 200, "Reopen is accepted");
  await page.getByLabel("Reply").waitFor({ timeout: 30_000 }).then(
    () => check(true, "Reopen brings the reply box back"),
    () => check(false, "Reopen brings the reply box back"),
  );
  const status = (await one(`SELECT status FROM "SupportTicket" WHERE id = $1`, [ticketId]))?.status;
  check(status === "OPEN" || status === "AWAITING_CUSTOMER", "the ticket is open again", status);
  await shot(page, "owner-ticket-reopened");
}

/** Invite -> accept from the /dev/mailbox link in a fresh context -> change role -> remove. */
async function teamJourney(page, fx) {
  const email = `portal-check-${TAG}@example.test`;
  const name = `Portal Check ${TAG}`;
  created.inviteEmail = email;
  await go(page, "/account/team");
  await page.getByRole("button", { name: "Invite member", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await dialog.getByLabel("Work email").fill(email);
  await dialog.getByRole("radio", { name: /Technical contact/ }).click();
  const res = page.waitForResponse((r) => r.url().endsWith("/api/account/team") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send invite", exact: true }).click();
  check((await res).status() === 201, "Send invite answers 201");
  check(await waitForToast(page, `Invitation sent to ${email}`), "\"Invitation sent to …\" toast", await toasts(page));

  const mail = await waitForMail(email, /invited you to/).catch((error) => (check(false, "the invitation email reaches /dev/mailbox", error.message), null));
  if (!mail) return;
  check(true, "the invitation email reaches /dev/mailbox");
  const invitee = await open({ width: 1280 });
  try {
    await go(invitee.page, `/dev/mailbox?id=${encodeURIComponent(mail.id)}`);
    const text = await invitee.page.locator("pre").first().textContent();
    const link = /(https?:\/\/[^\s"<>]+\/invite\?token=[^\s"<>]+)/.exec(text ?? "")?.[1];
    check(Boolean(link), "the email carries an /invite link");
    if (!link) return;
    const url = new URL(link);
    await go(invitee.page, url.pathname + url.search);
    await invitee.page.locator("#invite-name").fill(name);
    await invitee.page.locator("#invite-password").fill(`Pc${randomBytes(8).toString("hex")}7`);
    await Promise.all([
      invitee.page.waitForURL((u) => new URL(u).pathname === "/account", { timeout: 60_000 }),
      invitee.page.getByRole("button", { name: "Accept invitation", exact: true }).click(),
    ]);
    await invitee.page.locator("h1").first().waitFor({ timeout: 60_000 });
    check((await invitee.page.locator("aside").first().innerText()).includes(fx.accountName), "the invitee lands in the business's portal");
    const member = await one(
      `SELECT m.role, m.status FROM "AccountMember" m JOIN "User" u ON u.id = m."userId" WHERE u.email = $1 AND m."accountId" = $2`,
      [email, fx.accountId],
    );
    check(member?.status === "ACTIVE" && member?.role === "TECHNICAL", "the invitee is an active Technical contact", JSON.stringify(member));

    await go(page, "/account/team");
    await visible(page.getByRole("combobox", { name: `Role for ${name}`, exact: true })).click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    const roleDialog = page.getByRole("dialog").or(page.getByRole("alertdialog")).first();
    await roleDialog.getByRole("button", { name: "Change role", exact: true }).click();
    check(await waitForToast(page, "Role updated"), "changing the role shows \"Role updated\"", await toasts(page));
    check((await one(`SELECT m.role FROM "AccountMember" m JOIN "User" u ON u.id = m."userId" WHERE u.email = $1`, [email]))?.role === "VIEWER", "the member is now a Viewer");

    await visible(page.getByRole("button", { name: `Remove ${name}`, exact: true })).click();
    const removeDialog = page.getByRole("dialog").or(page.getByRole("alertdialog")).first();
    await removeDialog.getByRole("button", { name: "Remove", exact: true }).click();
    check(await waitForToast(page, "Access removed"), "removing the member shows \"Access removed\"", await toasts(page));
    check(!(await one(`SELECT 1 FROM "AccountMember" m JOIN "User" u ON u.id = m."userId" WHERE u.email = $1`, [email])), "the membership is gone");
    await go(invitee.page, "/account");
    check((await invitee.page.locator("main").innerText()).includes("No business account"), "the removed member no longer reaches the account");
  } finally {
    await close(invitee, "invitee context");
  }
}

async function activityExportJourney(page) {
  await go(page, "/account/activity");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Export CSV", exact: true }).first().click(),
  ]);
  const file = await download.path();
  const csv = file ? fs.readFileSync(file, "utf8") : "";
  check(download.suggestedFilename().endsWith(".csv"), `Export CSV downloads a .csv (${download.suggestedFilename()})`);
  check(csv.startsWith("\uFEFF") && /^.?"?When"?,/.test(csv), "the CSV has a BOM and the When column first", csv.slice(0, 80));
  check(csv.split(/\r?\n/).filter(Boolean).length > 1, "the CSV has rows");
  check(await waitForToast(page, "Exported"), "the export toast names the rows", await toasts(page));
}

async function preferencesJourney(page, fx) {
  const label = "New versions & release notes";
  const prefs = async () => (await one(`SELECT "notificationPrefs" AS p FROM "User" WHERE email = $1`, [USERS.owner.email]))?.p ?? null;
  await go(page, "/account/notifications");
  const toggle = async () => {
    const sw = page.getByRole("switch", { name: label });
    const before = await sw.getAttribute("aria-checked");
    const res = page.waitForResponse((r) => r.url().endsWith("/api/account/notifications") && r.request().method() === "PATCH");
    await sw.click();
    const status = (await res).status();
    check(status === 200, `switching "${label}" saves (PATCH 200)`, `status ${status}`);
    return before;
  };
  const before = await toggle();
  await go(page, "/account/notifications");
  const after = await page.getByRole("switch", { name: label }).getAttribute("aria-checked");
  check(after !== before, `"${label}" stays switched after a reload`, `${before} -> ${after}`);
  check(String((await prefs())?.updates) === after, "the preference is stored", JSON.stringify(await prefs()));
  await toggle();
  check(String((await prefs())?.updates) === before, "the preference is restored");
  void fx;
}

/** Signs Priya in once more through the API (another device), then "Sign out all others" from the Security page. */
async function signOutOthersJourney(page) {
  const other = await playwrightRequest.newContext({ baseURL: BASE });
  try {
    const { token } = await (await other.get("/api/csrf")).json();
    const signIn = await other.post("/api/auth/sign-in", { headers: { "x-csrf-token": token, origin: BASE }, data: { email: USERS.owner.email, password: PASSWORD } });
    check(signIn.status() === 200, "a second session signs in (API)", `status ${signIn.status()}`);
    check((await other.get("/api/me")).status() === 200, "the second session is valid");
    await go(page, "/account/security");
    await page.getByRole("button", { name: "Sign out all others", exact: true }).first().click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    check((await dialog.innerText()).includes("Sign out all other sessions?"), "Sign out all others asks for confirmation");
    await dialog.getByRole("button", { name: "Sign out all others", exact: true }).click();
    check(await waitForToast(page, "Other sessions signed out"), "\"Other sessions signed out\" toast", await toasts(page));
    check((await other.get("/api/me")).status() === 401, "the other session is signed out (401)");
    const sessions = await page.evaluate(async () => (await (await fetch("/api/me/sessions", { cache: "no-store" })).json()).sessions ?? []);
    check(sessions.length === 1 && sessions[0]?.current === true, "only the current session is left", `${sessions.length} sessions`);
  } finally {
    await other.dispose();
  }
}

async function step(name, fn) {
  const before = results.filter((r) => !r.ok).length;
  current = name;
  try {
    await fn();
  } catch (error) {
    check(false, `${name} completes`, error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
  if (VERBOSE || results.filter((r) => !r.ok).length > before) console.info(`-- ${name}: ${results.filter((r) => !r.ok).length > before ? "failed" : "ok"}`);
}

async function ownerJourneys(fx) {
  const s = await open({ role: "owner", width: 1280, downloads: true });
  const { page } = s;
  try {
    let key = null;
    await step("owner: reveal key", async () => {
      if (!fx.spare) throw new Error("no license with a free device slot and a deactivation left");
      key = await revealKey(page, fx.spare.id, { wrongFirst: true });
    });
    await step("owner: device rename, move, deactivate", async () => {
      if (!key) throw new Error("no revealed key");
      await deviceJourney(page, fx, key);
    });
    key = null;
    await step("owner: renewal to cart", () => renewalJourney(page, fx));
    await step("owner: billing", () => billingJourney(page));
    await step("owner: ticket", () => ticketJourney(page));
    await step("owner: team invite", () => teamJourney(page, fx));
    await step("owner: activity CSV", () => activityExportJourney(page));
    await step("owner: notification preferences", () => preferencesJourney(page, fx));
    await step("owner: sign out other sessions", () => signOutOthersJourney(page));
  } finally {
    current = "owner";
    await close(s, "owner journeys");
  }
}

async function tooltipOf(page, locator) {
  await locator.hover();
  return page.locator("[role=tooltip]").first().innerText({ timeout: 5_000 }).catch(() => null);
}

async function billingRoleJourneys(fx) {
  const s = await open({ role: "billing", width: 1280 });
  const { page } = s;
  try {
    await step("billing: no reveal", async () => {
      await go(page, `/account/licenses/${fx.withDevices}`);
      const reveal = page.getByRole("button", { name: "Reveal", exact: true });
      check((await actionState(reveal)) === "disabled", "Reveal is disabled", await actionState(reveal));
      check((await tooltipOf(page, visible(reveal))) === "Requires Owner or Technical contact", "Reveal explains \"Requires Owner or Technical contact\"");
      const status = await apiStatus(page, "POST", `/api/account/licenses/${fx.withDevices}/reveal`, { password: "not-checked-9" });
      check(status === 403, "POST …/reveal answers 403", `status ${status}`);
    });
    await step("billing: no deactivate", async () => {
      await go(page, `/account/licenses/${fx.withDevices}?tab=devices`);
      const buttons = page.getByRole("button", { name: /^Deactivate / });
      check((await actionState(buttons)) === "disabled", "Deactivate is disabled", await actionState(buttons));
      const status = await apiStatus(page, "POST", `/api/account/licenses/${fx.withDevices}/devices/${fx.device.id}/deactivate`, {});
      check(status === 403, "POST …/deactivate answers 403", `status ${status}`);
      check((await one(`SELECT "deactivatedAt" FROM "DeviceActivation" WHERE id = $1`, [fx.device.id]))?.deactivatedAt == null, "the device stays active");
    });
    await step("billing: no download", async () => {
      await go(page, "/account/software");
      const downloads = page.getByRole("button", { name: /^v[0-9][^ ]* for / });
      const states = await Promise.all((await downloads.filter({ visible: true }).all()).map((b) => b.getAttribute("aria-disabled")));
      check(states.length > 0 && states.every((v) => v === "true"), "every download button is disabled", JSON.stringify(states));
      const status = await apiStatus(page, "POST", "/api/account/downloads", { releaseFileId: fx.releaseFile });
      check(status === 403, "POST /api/account/downloads answers 403", `status ${status}`);
    });
    await step("billing: edit billing", () => billingJourney(page));
    await step("billing: navigation", async () => {
      await go(page, "/account");
      const links = await navLinks(page);
      check(!links.some((l) => /^(Team|Activity)/.test(l)), "Team and Activity log are not in the navigation", links.join(", "));
    });
  } finally {
    current = "billing";
    await close(s, "billing journeys");
  }
}

async function technicalRoleJourneys(fx) {
  const s = await open({ role: "technical", width: 1280, downloads: true });
  const { page } = s;
  try {
    await step("technical: download", async () => {
      await go(page, "/account/software");
      const button = visible(page.getByRole("button", { name: /^v[0-9][^ ]* for / }));
      check((await button.getAttribute("aria-disabled")) !== "true", "the download button is enabled");
      const res = page.waitForResponse((r) => r.url().endsWith("/api/account/downloads") && r.request().method() === "POST");
      const download = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
      await button.click();
      const status = (await res).status();
      check(status === 200, "POST /api/account/downloads answers 200", `status ${status}`);
      const file = await download;
      check(Boolean(file), `the installer downloads${file ? ` (${file.suggestedFilename()})` : ""}`);
    });
    await step("technical: reveal", async () => {
      await revealKey(page, fx.withDevices);
    });
    await step("technical: billing read-only", async () => {
      await go(page, "/account/billing");
      check(await page.getByLabel("Registered address").evaluate((el) => el.readOnly), "the billing fields are read-only");
      const save = page.getByRole("button", { name: "Save details", exact: true });
      check((await actionState(save)) === "disabled", "Save details is disabled", await actionState(save));
      check((await tooltipOf(page, visible(save))) === "Requires Owner or Billing admin", "Save explains \"Requires Owner or Billing admin\"");
      const status = await apiStatus(page, "PATCH", "/api/account/billing", {});
      check(status === 403, "PATCH /api/account/billing answers 403", `status ${status}`);
    });
    await step("technical: no team or activity", async () => {
      await go(page, "/account");
      const links = await navLinks(page);
      check(!links.some((l) => /^(Team|Activity)/.test(l)), "Team and Activity log are not in the navigation", links.join(", "));
      check((await apiStatus(page, "GET", "/api/account/team")) === 403, "GET /api/account/team answers 403");
      check((await apiStatus(page, "GET", "/api/account/activity")) === 403, "GET /api/account/activity answers 403");
    });
  } finally {
    current = "technical";
    await close(s, "technical journeys");
  }
}

// ---------- clean-up (local dev database only) ----------
async function cleanUp(fx, runStart) {
  current = "clean-up";
  if (KEEP_DATA || !LOCAL) {
    console.info(KEEP_DATA ? "Keeping the data the journeys created (--keep-data)." : "Remote server: nothing cleaned up.");
    return;
  }
  const done = [];
  const q = async (label, sql, params) => {
    const res = await db.query(sql, params);
    if (res.rowCount) done.push(`${res.rowCount} ${label}`);
  };
  if (created.deviceIds.length) {
    await q("device activation(s)", `DELETE FROM "DeviceActivation" WHERE id = ANY($1)`, [created.deviceIds]);
  }
  if (fx.spare) {
    await q("license event(s)", `DELETE FROM "LicenseEvent" WHERE "licenseId" = ANY($1) AND "createdAt" >= $2::timestamp`, [[fx.spare.id, fx.withDevices].filter(Boolean), runStart]);
    await q("deactivation counter(s) restored", `UPDATE "License" SET "selfServiceResets" = $2, "resetsYear" = $3 WHERE id = $1 AND ("selfServiceResets" <> $2 OR "resetsYear" <> $3)`, [
      fx.spare.id,
      fx.spare.selfServiceResets,
      fx.spare.resetsYear,
    ]);
  }
  if (created.ticketIds.length) {
    const uploads = await all(
      `SELECT u.id, u."storageKey" FROM "Upload" u WHERE u."accountId" = $1 AND (u."createdAt" >= $2::timestamp OR u."ticketMessageId" IN (SELECT id FROM "TicketMessage" WHERE "ticketId" = ANY($3)))`,
      [fx.accountId, runStart, created.ticketIds],
    );
    const root = path.resolve(ENV.STORAGE_LOCAL_DIR || ".storage");
    for (const upload of uploads) {
      const file = path.resolve(root, ...upload.storageKey.split("/"));
      if (!file.startsWith(root + path.sep)) continue;
      fs.rmSync(file, { force: true });
      const dir = path.dirname(file);
      if (dir !== root && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    await q("upload(s)", `DELETE FROM "Upload" WHERE id = ANY($1)`, [uploads.map((u) => u.id)]);
    await q("ticket(s) with their messages", `DELETE FROM "SupportTicket" WHERE id = ANY($1)`, [created.ticketIds]);
  }
  if (created.inviteEmail) {
    await q("outbox email(s)", `DELETE FROM "OutboxEmail" WHERE "to" = $1`, [created.inviteEmail]);
    await q("invited user(s)", `DELETE FROM "User" WHERE email = $1`, [created.inviteEmail]);
  }
  await q("account activity row(s)", `DELETE FROM "AccountActivity" WHERE "accountId" = $1 AND "createdAt" >= $2::timestamp`, [fx.accountId, runStart]);
  await q("download event(s)", `DELETE FROM "DownloadEvent" WHERE "createdAt" >= $1::timestamp AND "userId" = ANY($2)`, [runStart, fx.members.map((m) => m.id)]);
  console.info(`Clean-up: ${done.length ? done.join(", ") : "nothing to remove"}.`);
}

// ---------- main ----------
await db.connect();
let fx = null;
let runStart = null;
try {
  // Prisma stores DateTime as UTC wall-clock "timestamp(3)" columns: keep the start as UTC text, never as a JS Date
  // (node-pg would send a Date with the local offset, which Postgres drops for a timestamp column).
  runStart = (await one(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS t`)).t;
  fx = await loadFixtures();
  console.info(
    `Portal check on ${BASE} (${fx.accountName}): license ${fx.withDevices ?? "none"}, spare ${fx.spare?.id ?? "none"}, ticket ${fx.ticket ?? "none"}`,
  );
  await resetSharedIpBuckets();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const needed = new Set([...(ONLY.has("pages") ? ROLES : []), ...["owner", "billing", "technical"].filter((r) => ONLY.has(r))]);
  for (const role of needed) await signInViaUi(role);
  if (ONLY.has("pages")) await runPages(fx);
  if (ONLY.has("owner") && STATES.owner) await ownerJourneys(fx);
  if (ONLY.has("billing") && STATES.billing) await billingRoleJourneys(fx);
  if (ONLY.has("technical") && STATES.technical) await technicalRoleJourneys(fx);
} catch (error) {
  check(false, "the check runs to the end", error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  if (fx && runStart) await cleanUp(fx, runStart).catch((error) => check(false, "clean-up", error instanceof Error ? error.message : String(error)));
  await db.end().catch(() => {});
}

report.finishedAt = new Date().toISOString();
report.results = results;
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(report, null, 2));
const failures = results.filter((r) => !r.ok);
const pageFailures = new Set(failures.filter((f) => f.scenario === "pages").map((f) => f.label.split(":")[0]));
const loads = report.pages.length;
console.info(
  `\n${results.length} checks, ${failures.length} failure${failures.length === 1 ? "" : "s"}` +
    (loads ? ` (${loads} page loads, ${pageFailures.size} with problems)` : "") +
    ".",
);
if (failures.length) {
  console.info("\nFailures:");
  for (const f of failures) console.info(`  [${f.scenario}] ${f.label}${f.detail !== undefined ? ` -> ${String(f.detail).slice(0, 600)}` : ""}`);
}
process.exit(failures.length ? 1 : 0);
