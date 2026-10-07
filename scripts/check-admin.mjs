/**
 * Admin console check (dev tool). Drives the real app in the locally installed Google Chrome (Playwright, channel
 * "chrome") as the four staff roles, each signed in through the /sign-in form with the two-step code read from
 * /dev/mailbox: the Owner (SEED_OWNER_EMAIL), Vikram (Administrator), Sneha (Support) and Karan (Finance).
 *
 *   node scripts/check-admin.mjs [--base=http://localhost:3000] [--only=pages,reasons,admin,support,finance,owner]
 *     [--roles=owner,admin,support,finance] [--widths=1280,360] [--concurrency=3] [--shots=<dir>] [--json=<file>]
 *     [--keep-data] [--keep-limits] [--verbose]
 *
 *   pages    Every /admin module (lib/rbac.ts ADMIN_MODULES), a few drawers (?id=) and an unknown admin URL, for each
 *            role at each width: HTTP 200 (the unknown URL shows the noindex in-shell "Page not found"), the
 *            permission-denied panel exactly on the modules lib/rbac.ts locks for the role (and the sidebar lock on the
 *            same modules), no console errors, page errors, 404s or 5xx responses, no horizontal overflow, one <h1> and
 *            one main landmark, and no axe-core violations (WCAG 2.0 A/AA and 2.1 AA).
 *   reasons  Every destructive or reason-bearing admin API (DESTRUCTIVE_ACTIONS plus release withdraw, order review and
 *            the bulk license and plan actions) answers 422 `reason_required` without a reason and 422 with a
 *            2-character one, as the Owner, against real records (an invited staff member's invitation, a draft
 *            release and its installer when the data has them); nothing changes (no audit rows; the license,
 *            category, release, installer, staff, coupon, FAQ, plan and product targets are unchanged). In the UI,
 *            "Revoke invitation" (staff drawer of an invited member) keeps its confirm button disabled until a
 *            reason of 4+ characters is typed, then is cancelled.
 *   admin    Vikram changes a plan price (audit row "old -> new"; the storefront product page shows the new price
 *            after revalidation; the price is then restored), creates a draft release, uploads a small installer
 *            ("Remove" installer and "Delete draft" both refuse to confirm without a reason, then are cancelled),
 *            publishes it (in-app notification for an entitled account), withdraws it again, creates an empty
 *            category through the API and deletes it in the category dialog (reason required; one "Deleted category"
 *            audit row with the reason), and creates, activates, pauses and deletes a coupon.
 *   support  Sneha replies to a ticket that Priya (Sharma Medicals) opened and adds an internal note: the portal shows
 *            the reply, never the note. She suspends and reinstates a license with reasons. Finance cannot open
 *            Tickets (403).
 *   finance  Priya buys a license with the mock provider; Karan cannot revoke it (disabled button, API 403), then
 *            refunds the order with a reason and the typed order id: the license is revoked in Priya's portal and the
 *            refund carries a credit note number.
 *   owner    The Owner invites a staff member (accepted from the /dev/mailbox link in a fresh browser), changes their
 *            role, edits a setting (audit row; then restored) and exports the audit log CSV.
 *
 * Needs the development server with PAYMENT_PROVIDER=mock, EMAIL_TRANSPORT=console and STORAGE_DRIVER=local, the seed
 * (`pnpm db:seed`; SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD / SEED_DEMO_PASSWORD in .env.local) and DATABASE_URL in
 * .env.local. With TRUSTED_PROXY_HOPS=0 every local request shares the "unknown" IP rate-limit buckets, so the script
 * first deletes those rows (local servers only; --keep-limits skips it). Afterwards it removes exactly the rows the
 * journeys created (recorded by id: the order and its license, payments, refund, invoice and webhooks; the release and
 * its files; the category; the ticket; the invited staff member; and the audit, activity, notification, outbox and license-event
 * rows written during the journeys), unless --keep-data (local servers only). Counter values used up (order, invoice,
 * credit note, license and ticket numbers) are never lowered. Every browser session it opened is signed out. Never
 * prints passwords, keys, codes or tokens. Exit code 1 when any check fails.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import pg from "pg";
import { tsImport } from "tsx/esm/api";

/** lib/rbac.ts is the single source of the expected locks and destructive-action rules. */
const rbac = await tsImport("../lib/rbac.ts", import.meta.url);

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const BASE = new URL(opt.base ?? process.env.ADMIN_BASE_URL ?? "http://localhost:3000").origin;
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname);
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = new Set(list(opt.only ?? "pages,reasons,admin,support,finance,owner"));
const ROLES = list(opt.roles ?? "owner,admin,support,finance");
const WIDTHS = list(opt.widths ?? "1280,360").map(Number).filter((n) => n > 0);
const CONCURRENCY = Math.max(1, Number(opt.concurrency ?? 3));
const SHOTS = opt.shots ? path.resolve(opt.shots) : null;
const KEEP_DATA = opt["keep-data"] === "true";
const VERBOSE = opt.verbose === "true";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const TAG = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const DENIED = "You don’t have access to";
// API refusals the journeys provoke on purpose (403 role checks, 422 missing reasons) are logged by the browser.
const EXPECTED_REFUSAL = /status of (401|403|409|422)\b/;

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
const DEMO_PASSWORD = ENV.SEED_DEMO_PASSWORD ?? "";
if (!DEMO_PASSWORD || !ENV.SEED_OWNER_EMAIL || !ENV.SEED_OWNER_PASSWORD) {
  console.error("SEED_DEMO_PASSWORD, SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD must be set in .env.local.");
  process.exit(2);
}

/** The four staff roles (seed) and the portal customer the journeys use. */
const USERS = {
  owner: { email: ENV.SEED_OWNER_EMAIL, password: ENV.SEED_OWNER_PASSWORD, role: "OWNER", label: "Owner", home: "/admin" },
  admin: { email: "vikram@axiomatic.example", password: DEMO_PASSWORD, role: "ADMIN", label: "Vikram (Administrator)", home: "/admin" },
  support: { email: "sneha@axiomatic.example", password: DEMO_PASSWORD, role: "SUPPORT", label: "Sneha (Support)", home: "/admin" },
  finance: { email: "karan@axiomatic.example", password: DEMO_PASSWORD, role: "FINANCE", label: "Karan (Finance)", home: "/admin" },
  customer: { email: "priya@sharmamedicals.example", password: DEMO_PASSWORD, role: null, label: "Priya (customer Owner)", home: "/account" },
};
const STAFF_KEYS = ["owner", "admin", "support", "finance"];

const results = [];
let current = "setup";
function check(ok, label, detail) {
  results.push({ scenario: current, ok: Boolean(ok), label, detail: ok ? undefined : detail });
  if (!ok || VERBOSE) console.info(`${ok ? "PASS" : "FAIL"} [${current}] ${label}${!ok && detail !== undefined ? ` -> ${String(detail).slice(0, 600)}` : ""}`);
  return Boolean(ok);
}
const errText = (error) => (error instanceof Error ? error.message : String(error));

// ---------- database (fixtures, checks, clean-up of what this run created) ----------
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

/**
 * Ids that existed before the journeys, per table. Clean-up deletes only rows that are new AND belong to this run's
 * records (our staff as actor, our accounts, our targets); see cleanUp().
 */
const SNAPSHOT_TABLES = ["AuditLog", "AccountActivity", "Notification", "OutboxEmail", "LicenseEvent"];
const snapshot = {};
async function takeSnapshot() {
  for (const table of SNAPSHOT_TABLES) snapshot[table] = new Set((await all(`SELECT id FROM "${table}"`)).map((r) => r.id));
}
async function newIds(table, where, params) {
  const rows = await all(`SELECT id FROM "${table}" WHERE ${where}`, params);
  return rows.map((r) => r.id).filter((id) => !snapshot[table]?.has(id));
}

/** Everything the journeys create, by id. */
const created = {
  orderIds: [],
  licenseIds: [],
  releaseIds: [],
  ticketIds: [],
  couponCodes: [],
  categoryIds: [],
  staffUserIds: [],
  /** Existing records the journeys touched (suspended and reinstated, price changed and restored...). */
  touchedLicenseIds: [],
  accountIds: [],
  emails: [],
  targets: [],
};
const remember = (key, value) => {
  if (value !== null && value !== undefined && !created[key].includes(value)) created[key].push(value);
};

/** Seed objects the checks use, looked up rather than hard-coded where the seed allows. */
async function loadFixtures() {
  const staff = {};
  for (const key of STAFF_KEYS) {
    const row = await one(`SELECT id, "staffRole" FROM "User" WHERE email = $1 AND kind = 'STAFF' AND "staffStatus" = 'ACTIVE'`, [USERS[key].email]);
    if (!row || row.staffRole !== USERS[key].role) throw new Error(`${USERS[key].email} is not an active ${USERS[key].role}: run the seed (pnpm db:seed).`);
    staff[key] = row.id;
  }
  const customer = await one(
    `SELECT m."accountId", a."legalName", u.id AS "userId" FROM "AccountMember" m JOIN "User" u ON u.id = m."userId"
       JOIN "BusinessAccount" a ON a.id = m."accountId"
      WHERE u.email = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE' ORDER BY m."createdAt" LIMIT 1`,
    [USERS.customer.email],
  );
  if (!customer) throw new Error(`${USERS.customer.email} owns no business account: run the seed (pnpm db:seed).`);
  const usable = `l.status = 'ACTIVE' AND (l."expiresAt" IS NULL OR l."expiresAt" > now())`;
  // Support's suspend / reinstate target: a claimed, usable license of another business.
  const license = await one(
    `SELECT l.id, l."accountId" FROM "License" l JOIN "Plan" p ON p.id = l."planId"
      WHERE ${usable} AND l."accountId" IS NOT NULL AND l."accountId" <> $1 AND p.type <> 'TRIAL' ORDER BY l.id LIMIT 1`,
    [customer.accountId],
  );
  const device = await one(`SELECT id, "licenseId" FROM "DeviceActivation" WHERE "deactivatedAt" IS NULL ORDER BY "activatedAt" LIMIT 1`);
  const suspended = await one(`SELECT id FROM "License" WHERE status = 'SUSPENDED' ORDER BY id LIMIT 1`);
  // A product Priya's business is entitled to updates for (release notifications reach her).
  const entitled = await one(
    `SELECT l."productId" FROM "License" l JOIN "Product" p ON p.id = l."productId"
      WHERE l."accountId" = $1 AND l.status IN ('ACTIVE', 'TRIAL') AND (l."expiresAt" IS NULL OR l."expiresAt" > now())
        AND l."updatesUntil" > now() + interval '1 day' AND p.status = 'PUBLISHED'
      ORDER BY (l."productId" = 'medical-billing') DESC, l.id LIMIT 1`,
    [customer.accountId],
  );
  // A plan on sale whose price the storefront shows: the Administrator changes and restores it.
  const plan = await one(
    `SELECT pl.id, pl."productId", pl."pricePaise", pl.name FROM "Plan" pl JOIN "Product" p ON p.id = pl."productId"
      WHERE pl.archived = false AND pl."pricePaise" > 0 AND pl.type IN ('ONE_TIME', 'ANNUAL') AND p.status = 'PUBLISHED'
      ORDER BY (pl.id = 'chq-office') DESC, pl.id LIMIT 1`,
  );
  // A plan Priya can buy for the refund journey (one license, cheapest one-time plan).
  const buyPlan = await one(
    `SELECT pl.id, pl."productId" FROM "Plan" pl JOIN "Product" p ON p.id = pl."productId"
      WHERE pl.archived = false AND pl.type = 'ONE_TIME' AND pl."pricePaise" > 0 AND p.status = 'PUBLISHED'
      ORDER BY pl."pricePaise", pl.id LIMIT 1`,
  );
  const paidOrder = await one(`SELECT id FROM "Order" WHERE status = 'PAID' ORDER BY "createdAt" DESC LIMIT 1`);
  const reviewOrder = await one(`SELECT id FROM "Order" WHERE status = 'REVIEW' ORDER BY "createdAt" DESC LIMIT 1`);
  const product = await one(`SELECT id FROM "Product" WHERE status = 'PUBLISHED' ORDER BY rank, id LIMIT 1`);
  const coupon = await one(`SELECT code FROM "Coupon" ORDER BY code LIMIT 1`);
  const faq = await one(`SELECT id FROM "Faq" ORDER BY page, "sortOrder" LIMIT 1`);
  const release = await one(`SELECT id FROM "Release" WHERE status = 'PUBLISHED' ORDER BY "releasedAt" DESC NULLS LAST LIMIT 1`);
  // Targets of the delete reason checks (never deleted: every call lacks a valid reason).
  // A draft release (and its installer) and an invited staff member are the realistic targets when the data has them;
  // otherwise the checks fall back to a published release, any installer and an active staff member (the API still
  // has to refuse a missing reason first).
  const category = await one(`SELECT id, tone, icon FROM "Category" ORDER BY "sortOrder", id LIMIT 1`);
  const draftRelease = await one(`SELECT id FROM "Release" WHERE status = 'DRAFT' ORDER BY "createdAt" DESC LIMIT 1`);
  const releaseFile = await one(
    `SELECT f.id, f."releaseId" FROM "ReleaseFile" f JOIN "Release" r ON r.id = f."releaseId" ORDER BY (r.status = 'DRAFT') DESC, f.id LIMIT 1`,
  );
  const invitedStaff = await one(`SELECT id, email FROM "User" WHERE kind = 'STAFF' AND "staffStatus" = 'INVITED' ORDER BY "createdAt" LIMIT 1`);
  const ticket = await one(`SELECT id FROM "SupportTicket" ORDER BY "updatedAt" DESC LIMIT 1`);
  const otherStaff = await one(
    `SELECT id FROM "User" WHERE kind = 'STAFF' AND "staffStatus" = 'ACTIVE' AND "staffRole" = 'SUPPORT' AND email <> $1 ORDER BY email LIMIT 1`,
    [USERS.support.email],
  );
  const audit = await one(`SELECT id FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 1`);
  const missing = Object.entries({ license, plan, buyPlan, paidOrder, product, coupon, faq, release, entitled, otherStaff })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`seed data missing for: ${missing.join(", ")} (run pnpm db:seed)`);
  return {
    staff,
    customer,
    license,
    device,
    suspended,
    entitledProductId: entitled.productId,
    plan,
    buyPlan,
    paidOrder: paidOrder.id,
    reviewOrder: reviewOrder?.id ?? null,
    product: product.id,
    coupon: coupon.code,
    faq: faq.id,
    release: release.id,
    draftRelease: draftRelease?.id ?? null,
    category: category?.id ?? null,
    categoryStyle: category ? { tone: category.tone, icon: category.icon } : null,
    releaseFile: releaseFile ?? null,
    invitedStaff: invitedStaff ?? null,
    ticket: ticket?.id ?? null,
    otherStaff: otherStaff.id,
    audit: audit?.id ?? null,
  };
}

// ---------- browser ----------
let browser;
const STATES = {};

/** A context at `width`, signed in as `who` (storage state from the UI sign-in) or signed out. */
async function open({ who = null, width = 1280, downloads = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    acceptDownloads: downloads,
    ...(who ? { storageState: STATES[who] } : {}),
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error" || EXPECTED_REFUSAL.test(msg.text()) || /status of (404|5[0-9][0-9])/.test(msg.text())) return;
    problems.push(`console: ${msg.text().slice(0, 300)}`);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status !== 404 && status < 500) return;
    const url = new URL(res.url());
    // Development hot-update manifests can 404 while the dev server compiles another route; they are not app requests.
    if (status === 404 && url.pathname.includes("/_next/static/webpack/")) return;
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
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, mask: [page.locator("code")] }).catch(() => {});
}

async function go(page, pathname) {
  const res = await page.goto(BASE + pathname, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  return res;
}

const toasts = (page) => page.locator("[data-sonner-toast]").allInnerTexts();
async function waitForToast(page, text, timeout = 20_000) {
  const toast = page.locator("[data-sonner-toast]", { hasText: text }).first();
  return toast.waitFor({ timeout }).then(() => true, () => false);
}

/** Calls an API from the page (same origin, CSRF token from GET /api/csrf): { status, body }. */
async function api(page, method, url, body) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const headers = {};
      if (method !== "GET") {
        const csrf = await (await fetch("/api/csrf", { cache: "no-store" })).json();
        headers["x-csrf-token"] = csrf.token;
        if (body !== undefined) headers["content-type"] = "application/json";
      }
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, body: json };
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

/** The open drawer (Radix Sheet) or alert dialog. */
const drawerOf = (page) => page.getByRole("dialog").filter({ visible: true }).last();
const alertOf = (page) => page.getByRole("alertdialog").filter({ visible: true }).last();

/** Fills the reason (and the typed id) of the open confirmation and presses its confirm button. */
async function confirmWith(page, { reason, typed, confirm }) {
  const dialog = alertOf(page);
  await dialog.waitFor({ timeout: 15_000 });
  if (reason !== undefined) await dialog.getByLabel("Reason (saved to the audit log)").fill(reason);
  if (typed !== undefined) await dialog.getByLabel(/^Type .+ to confirm$/).fill(typed);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
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

async function waitForMail(to, subjectRe, { exclude = new Set(), timeoutMs = 45_000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await mailbox()).find((m) => m.to === to && subjectRe.test(m.subject) && !exclude.has(m.id));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} matching ${subjectRe}`);
}

// ---------- sign-in ----------
/**
 * Signs in through the /sign-in form (staff confirm with the emailed two-step code from /dev/mailbox) and keeps the
 * context's storage state for every later context of that person.
 */
async function signInViaUi(who) {
  current = `sign-in ${who}`;
  const user = USERS[who];
  const s = await open({ width: 1280 });
  const { page } = s;
  try {
    const before = new Set((await mailbox()).map((m) => m.id));
    await go(page, `/sign-in?next=${encodeURIComponent(user.home)}`);
    // Typing before React hydrates the form makes dev builds log a hydration mismatch; wait until React owns it.
    await page.waitForFunction(() => {
      const el = document.querySelector("#sign-in-email");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    }, undefined, { timeout: 90_000 });
    await page.locator("#sign-in-email").fill(user.email);
    await page.locator("#sign-in-password").fill(user.password);
    await page.locator("main form").getByRole("button", { name: "Sign in", exact: true }).click();
    const step = await Promise.race([
      page.locator("#two-step-code").waitFor({ timeout: 60_000 }).then(() => "code"),
      page.waitForURL((u) => new URL(u).pathname.startsWith(user.home), { timeout: 60_000 }).then(() => "home"),
    ]);
    if (user.role) check(step === "code", `${user.label} must confirm with an emailed two-step code`, step);
    if (step === "code") {
      const mail = await waitForMail(user.email, /sign-in code/i, { exclude: before });
      const code = /(\d{6})/.exec(mail.subject)?.[1];
      if (!code) throw new Error("the sign-in code email has no code");
      await page.locator("#two-step-code").fill(code);
      await Promise.all([
        page.waitForURL((u) => new URL(u).pathname.startsWith(user.home), { timeout: 90_000 }),
        page.locator("main form").getByRole("button", { name: "Sign in", exact: true }).click(),
      ]);
    }
    await page.locator("h1").first().waitFor({ timeout: 90_000 });
    check(true, `${user.label} signs in through /sign-in and lands on ${user.home}`);
    STATES[who] = await s.ctx.storageState();
  } catch (error) {
    check(false, `${user.label} signs in through /sign-in and lands on ${user.home}`, errText(error));
    await shot(page, `sign-in-${who}-failure`);
  } finally {
    await close(s, `sign-in ${who}`);
  }
}

/** Signs out every session this run opened (POST /api/auth/sign-out revokes it on the server). */
async function signOutAll(extraStates = []) {
  for (const state of [...Object.values(STATES), ...extraStates]) {
    const ctx = await browser.newContext({ storageState: state });
    const page = await ctx.newPage();
    try {
      await go(page, "/sign-in");
      const res = await api(page, "POST", "/api/auth/sign-out", {});
      if (res.status !== 204) console.info(`note: sign-out answered ${res.status}`);
    } catch (error) {
      console.info(`note: sign-out failed: ${errText(error)}`);
    } finally {
      await ctx.close();
    }
  }
}

// ---------- pages ----------
const modulePath = (key) => (key === "overview" ? "/admin" : `/admin/${key}`);

/** Every module, drawers opened through ?id= (seed records) and an unknown admin URL. */
function pageRoutes(fx) {
  const modules = rbac.ADMIN_MODULES.map((m) => ({ key: m.key, path: modulePath(m.key) }));
  const drawers = [
    { key: "orders", path: `/admin/orders?id=${encodeURIComponent(fx.paidOrder)}` },
    { key: "licenses", path: `/admin/licenses?id=${encodeURIComponent(fx.license.id)}` },
    { key: "plans", path: `/admin/plans?id=${encodeURIComponent(fx.plan.id)}` },
    { key: "customers", path: `/admin/customers?id=${encodeURIComponent(fx.customer.accountId)}` },
    ...(fx.ticket ? [{ key: "tickets", path: `/admin/tickets?id=${encodeURIComponent(fx.ticket)}` }] : []),
    { key: "staff", path: `/admin/staff?id=${encodeURIComponent(fx.otherStaff)}` },
    ...(fx.audit ? [{ key: "audit", path: `/admin/audit?id=${encodeURIComponent(fx.audit)}` }] : []),
  ].map((r) => ({ ...r, drawer: true }));
  // Unknown admin URLs render the in-shell not-found page. app/admin/loading.tsx streams the shell first, so the status is
  // already 200 when notFound() runs (as /account/no-such-page in the portal); the page is noindex.
  return [...modules, ...drawers, { key: null, path: "/admin/no-such-page", expect: "Page not found", noindex: true, widths: [1280] }];
}

const report = { base: BASE, startedAt: new Date().toISOString(), pages: [], journeys: {} };

/** Failures of the Next.js / React development runtimes under load (impossible in a production build). */
const DEV_RUNTIME_FAILURES = [/Expected clientReferenceManifest to be defined/, /frame\.join is not a function/];

async function checkPage(who, route, width, attempt = 1) {
  const role = USERS[who].role;
  const label = `${route.path} as ${who} @${width}`;
  let retry = false;
  const s = await open({ who, width });
  const { page } = s;
  const entry = { who, path: route.path, width, status: null, violations: [] };
  report.pages.push(entry);
  try {
    const res = await go(page, route.path);
    await page.locator("main h1").first().waitFor({ timeout: 30_000 }).catch(() => {});
    const allowed = route.key === null || rbac.canViewModule(role, route.key);
    if (route.drawer && allowed) await drawerOf(page).waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(300);
    entry.status = res?.status() ?? null;
    if (attempt === 1 && s.problems.some((p) => DEV_RUNTIME_FAILURES.some((re) => re.test(p)))) {
      retry = true;
      return "retry";
    }
    check(entry.status === (route.status ?? 200), `${label}: HTTP ${route.status ?? 200}`, `status ${entry.status}`);
    const finalPath = new URL(page.url()).pathname;
    check(finalPath === new URL(route.path, BASE).pathname, `${label}: stays on the page`, `ended at ${finalPath}`);
    const facts = await page.evaluate(() => {
      const doc = document.documentElement;
      const nav = document.querySelector("nav[aria-label='Admin']");
      const navVisible = !!nav && nav.getBoundingClientRect().width > 0;
      return {
        h1: document.querySelectorAll("h1").length,
        main: document.querySelectorAll("main, [role='main']").length,
        title: document.title.trim(),
        text: document.body.innerText,
        overflow: doc.scrollWidth - doc.clientWidth,
        restricted: navVisible
          ? [...nav.querySelectorAll("a")].filter((a) => (a.textContent ?? "").includes(", restricted")).map((a) => (a.textContent ?? "").replace(/, restricted.*$/, "").trim())
          : null,
        dialog: !!document.querySelector("[role='dialog']"),
        robots: [...document.querySelectorAll("meta[name='robots']")].map((m) => m.getAttribute("content") ?? "").join(" "),
      };
    });
    Object.assign(entry, { h1: facts.h1, main: facts.main, title: facts.title, overflow: facts.overflow });
    check(facts.h1 === 1, `${label}: exactly one <h1>`, `${facts.h1} <h1> elements`);
    check(facts.main === 1, `${label}: exactly one main landmark`, `${facts.main} main landmarks`);
    check(facts.title.length > 0, `${label}: non-empty <title>`);
    check(facts.overflow <= 0, `${label}: no horizontal overflow`, `${facts.overflow}px`);
    const denied = facts.text.includes(DENIED);
    check(denied === !allowed, `${label}: ${allowed ? "opens" : "shows the permission-denied panel"} (lib/rbac.ts)`, denied ? "denied panel shown" : "module content shown");
    if (route.drawer) check(facts.dialog === allowed, `${label}: the drawer ${allowed ? "opens" : "stays closed"}`);
    if (facts.restricted && route.key === "overview") {
      const expected = rbac.lockedModulesFor(role).map((m) => m.label);
      check(JSON.stringify(facts.restricted) === JSON.stringify(expected), `${label}: the sidebar locks exactly ${expected.join(", ") || "nothing"}`, facts.restricted.join(", "));
    }
    if (route.expect) check(facts.text.includes(route.expect), `${label}: shows "${route.expect}"`);
    if (route.noindex) check(facts.robots.includes("noindex"), `${label}: is noindex`, facts.robots);
    check(!/Something went wrong|We can.t load the admin console|couldn.t load/i.test(facts.text), `${label}: no error state`);
    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    entry.violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
    check(entry.violations.length === 0, `${label}: no axe violations`, entry.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes}): ${v.help} -> ${v.targets.join(" | ")}`).join(" || "));
    if (entry.violations.length || facts.overflow > 0) await shot(page, `page-${who}-${width}-${route.path.replace(/[^a-z0-9]+/gi, "_")}`);
  } catch (error) {
    check(false, `${label}: loads`, errText(error));
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
  const roles = ROLES.filter((r) => STATES[r]);
  // Warm-up (a dev server compiles each route on first request), one page at a time.
  const warm = await open({ who: roles.includes("owner") ? "owner" : roles[0] });
  for (const route of routes) await go(warm.page, route.path).catch(() => {});
  await warm.ctx.close();
  const jobs = routes.flatMap((route) =>
    roles.flatMap((who) => (route.widths ?? WIDTHS).filter((w) => WIDTHS.includes(w)).map((width) => ({ who, route, width }))),
  );
  console.info(`Checking ${jobs.length} page loads (${routes.length} routes, ${roles.length} roles, widths ${WIDTHS.join("/")})`);
  await pool(jobs, CONCURRENCY, async ({ who, route, width }) => {
    if ((await checkPage(who, route, width)) !== "retry") return;
    console.info(`note: ${route.path} as ${who} @${width} hit a Next.js/React development-runtime failure; checked again`);
    await checkPage(who, route, width, 2);
  });
}

// ---------- reasons: every destructive API refuses a missing reason ----------
async function reasonsJourney(page, fx) {
  const L = fx.license.id;
  const cases = [
    ["orders.refund", "POST", `/api/admin/orders/${fx.paidOrder}/refund`, { confirmId: fx.paidOrder }],
    ["licenses.revoke", "POST", `/api/admin/licenses/${L}/revoke`, { confirmId: L }],
    ["licenses.suspend", "POST", `/api/admin/licenses/${L}/suspend`, {}],
    ["licenses.reinstate", "POST", `/api/admin/licenses/${fx.suspended?.id ?? L}/reinstate`, {}],
    ["licenses.extend", "POST", `/api/admin/licenses/${L}/extend`, { days: 30 }],
    ["licenses.reset_devices", "POST", `/api/admin/licenses/${L}/reset-devices`, {}],
    ["licenses.deactivate_device", "POST", fx.device ? `/api/admin/licenses/${fx.device.licenseId}/devices/${fx.device.id}/deactivate` : null, {}],
    ["licenses.issue_manual", "POST", "/api/admin/licenses", { accountId: fx.customer.accountId, planId: fx.buyPlan.id }],
    ["plans.archive", "POST", `/api/admin/plans/${fx.plan.id}/archive`, {}],
    ["plans.restore", "POST", `/api/admin/plans/${fx.plan.id}/restore`, {}],
    ["products.hide", "POST", `/api/admin/products/${fx.product}/hide`, {}],
    ["products.publish", "POST", `/api/admin/products/${fx.product}/publish`, {}],
    ["coupons.delete", "DELETE", `/api/admin/coupons/${encodeURIComponent(fx.coupon)}`, { confirmId: fx.coupon }],
    ["faqs.delete", "DELETE", `/api/admin/faqs/${fx.faq}`, {}],
    ["staff.change_role", "PATCH", `/api/admin/staff/${fx.otherStaff}`, { role: "ADMIN" }],
    ["staff.deactivate", "POST", `/api/admin/staff/${fx.otherStaff}/deactivate`, {}],
    ["staff.reactivate", "POST", `/api/admin/staff/${fx.otherStaff}/reactivate`, {}],
    ["staff.revoke_invite", "DELETE", `/api/admin/staff/${fx.invitedStaff?.id ?? fx.otherStaff}/invite`, {}],
    ["categories.delete", "DELETE", fx.category ? `/api/admin/categories/${encodeURIComponent(fx.category)}` : null, {}],
    ["releases.delete", "DELETE", `/api/admin/releases/${fx.draftRelease ?? fx.release}`, {}],
    [
      "releases.remove_installer",
      "DELETE",
      fx.releaseFile ? `/api/admin/releases/${fx.releaseFile.releaseId}/files/${fx.releaseFile.id}` : null,
      {},
    ],
    // Reason-bearing actions outside DESTRUCTIVE_ACTIONS.
    ["release withdraw", "POST", `/api/admin/releases/${fx.release}/withdraw`, {}],
    ["order review", "POST", `/api/admin/orders/${fx.reviewOrder ?? fx.paidOrder}/review`, {}],
    ["bulk license suspend", "POST", "/api/admin/licenses/bulk", { action: "suspend", ids: [L] }],
    ["bulk license extend", "POST", "/api/admin/licenses/bulk", { action: "extend", ids: [L], days: 30 }],
    ["bulk plan archive", "POST", "/api/admin/plans/bulk-archive", { ids: [fx.plan.id] }],
  ];
  const covered = new Set(cases.map(([key]) => key));
  const uncovered = Object.keys(rbac.DESTRUCTIVE_ACTIONS).filter((k) => !covered.has(k));
  check(uncovered.length === 0, "every DESTRUCTIVE_ACTIONS key has a reason check", uncovered.join(", "));
  const auditBefore = (await one(`SELECT count(*)::int AS n FROM "AuditLog"`)).n;
  const licenseBefore = await one(`SELECT status, "expiresAt" FROM "License" WHERE id = $1`, [L]);
  const targetsBefore = await reasonTargets(fx);
  for (const [key, method, url, body] of cases) {
    if (!url) {
      console.info(`note: no seeded target (device, category or installer); skipped ${key}`);
      continue;
    }
    const res = await api(page, method, url, body);
    check(res.status === 422 && res.body?.error?.code === "reason_required", `${key}: ${method} without a reason answers 422 reason_required`, `${res.status} ${res.body?.error?.code ?? ""}`);
    const withShort = await api(page, method, url, { ...body, reason: "no" });
    check(withShort.status === 422, `${key}: a 2-character reason answers 422`, `${withShort.status} ${withShort.body?.error?.code ?? ""}`);
  }
  check((await one(`SELECT count(*)::int AS n FROM "AuditLog"`)).n === auditBefore, "the refused calls wrote no audit rows");
  const licenseAfter = await one(`SELECT status, "expiresAt" FROM "License" WHERE id = $1`, [L]);
  check(JSON.stringify(licenseAfter) === JSON.stringify(licenseBefore), "the refused calls left the license unchanged");
  const targetsAfter = await reasonTargets(fx);
  for (const [name, before] of Object.entries(targetsBefore)) {
    const after = JSON.stringify(targetsAfter[name]);
    check(after === JSON.stringify(before), `the refused calls left the ${name} unchanged`, `${JSON.stringify(before)} -> ${after}`);
  }
  await revokeInviteDialog(page, fx);
}

/** The records the destructive reason checks aim at (category, release, installer, staff...), for a before/after compare. */
async function reasonTargets(fx) {
  const staffIds = [fx.otherStaff, fx.invitedStaff?.id].filter(Boolean);
  const releaseIds = [...new Set([fx.release, fx.draftRelease].filter(Boolean))];
  return {
    category: fx.category ? await one(`SELECT id, name, "sortOrder" FROM "Category" WHERE id = $1`, [fx.category]) : null,
    releases: await all(`SELECT id, status, "releasedAt" FROM "Release" WHERE id = ANY($1) ORDER BY id`, [releaseIds]),
    installer: fx.releaseFile ? await one(`SELECT id, "storageKey", "sizeBytes" FROM "ReleaseFile" WHERE id = $1`, [fx.releaseFile.id]) : null,
    "staff members": await all(`SELECT id, "staffStatus", "staffRole" FROM "User" WHERE id = ANY($1) ORDER BY id`, [staffIds]),
    "staff invitation links": fx.invitedStaff
      ? await all(`SELECT id, "expiresAt", "usedAt" FROM "AuthToken" WHERE "userId" = $1 AND type = 'STAFF_INVITE' ORDER BY id`, [fx.invitedStaff.id])
      : null,
    coupon: await one(`SELECT code, active FROM "Coupon" WHERE code = $1`, [fx.coupon]),
    faq: await one(`SELECT id, published FROM "Faq" WHERE id = $1`, [fx.faq]),
    plan: await one(`SELECT id, archived FROM "Plan" WHERE id = $1`, [fx.plan.id]),
    product: await one(`SELECT id, status FROM "Product" WHERE id = $1`, [fx.product]),
  };
}

/**
 * The open confirmation needs a reason: its confirm button stays disabled while the reason is empty or shorter than
 * 4 characters (lib/rbac.ts validateReason) and is enabled by a real one. Leaves the real reason typed.
 */
async function checkReasonGate(page, label, confirm) {
  const dialog = alertOf(page);
  await dialog.waitFor({ timeout: 15_000 });
  const reason = dialog.getByLabel("Reason (saved to the audit log)");
  const button = dialog.getByRole("button", { name: confirm, exact: true });
  check(await reason.isVisible().catch(() => false), `${label}: the confirmation asks for a reason`);
  check((await actionState(button)) === "disabled", `${label}: "${confirm}" is disabled without a reason`, await actionState(button));
  await reason.fill("no");
  check((await actionState(button)) === "disabled", `${label}: "${confirm}" stays disabled with a 2-character reason`, await actionState(button));
  await reason.fill(`Admin console check ${TAG}`);
  check((await actionState(button)) === "enabled", `${label}: a real reason enables "${confirm}"`, await actionState(button));
  return dialog;
}

/** Closes the open confirmation with Cancel (nothing is sent). */
async function cancelDialog(dialog) {
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
}

/** UI: "Revoke invitation" in an invited member's drawer asks for a reason; cancelled, so the invitation stays. */
async function revokeInviteDialog(page, fx) {
  if (!fx.invitedStaff) {
    console.info("note: no invited staff member in the data; skipped the Revoke invitation dialog check");
    return;
  }
  await go(page, `/admin/staff?id=${encodeURIComponent(fx.invitedStaff.id)}`);
  const drawer = drawerOf(page);
  const revoke = drawer.getByRole("button", { name: "Revoke invitation", exact: true });
  await revoke.waitFor({ timeout: 30_000 });
  await revoke.click();
  await cancelDialog(await checkReasonGate(page, "staff.revoke_invite (dialog)", "Revoke invitation"));
  const row = await one(`SELECT "staffStatus" FROM "User" WHERE id = $1`, [fx.invitedStaff.id]);
  check(row?.staffStatus === "INVITED", "cancelling Revoke invitation keeps the invitation", row?.staffStatus);
}

// ---------- journeys ----------
const rupees = (paise) => (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(intervalMs);
  }
}

/** The storefront product page's HTML (server-rendered; reads the catalog cache that revalidateTag refreshes). */
const storefrontHtml = async (productId) => (await fetch(`${BASE}/software/${encodeURIComponent(productId)}`, { cache: "no-store" })).text();

/** Sets the plan price in the open plan drawer and saves; resolves to the toast check. */
async function savePlanPrice(page, rupeesValue) {
  const drawer = drawerOf(page);
  await drawer.getByLabel("Price in ₹ (excl. GST)").fill(String(rupeesValue));
  await drawer.getByRole("button", { name: "Save changes", exact: true }).click();
  return waitForToast(page, "Changes saved");
}

async function adminPlanPrice(page, fx) {
  const plan = fx.plan;
  const oldRupees = plan.pricePaise / 100;
  const newRupees = Math.floor(oldRupees) + 12;
  await go(page, `/admin/plans?id=${encodeURIComponent(plan.id)}`);
  await drawerOf(page).getByLabel("Price in ₹ (excl. GST)").waitFor({ timeout: 30_000 });
  check(await savePlanPrice(page, newRupees), `the Administrator saves ${plan.id} at ₹${rupees(newRupees * 100)} ("Changes saved")`, await toasts(page));
  remember("targets", plan.id);
  const row = await one(
    `SELECT action, detail FROM "AuditLog" WHERE "targetId" = $1 AND "actorId" = $2 ORDER BY "createdAt" DESC LIMIT 1`,
    [plan.id, fx.staff.admin],
  );
  const detail = row?.detail ?? "";
  check(
    row?.action === "Changed plan price" && detail.includes(`₹${rupees(plan.pricePaise)}`) && detail.includes(`₹${rupees(newRupees * 100)}`) && detail.includes("→"),
    "the audit row records the price old -> new",
    JSON.stringify(row),
  );
  // The "Changes saved" toast of an earlier save may still be on screen, so poll the database instead of reading once.
  const priceIs = (paise) => waitFor(async () => (await one(`SELECT "pricePaise" FROM "Plan" WHERE id = $1`, [plan.id]))?.pricePaise === paise, { timeoutMs: 15_000 });
  check(await priceIs(newRupees * 100), "the plan's price changed in the database");
  const shown = (html) => html.includes(rupees(newRupees * 100)) || html.includes(rupees(Math.round(newRupees * 118)));
  check(await waitFor(async () => shown(await storefrontHtml(plan.productId)), { timeoutMs: 30_000, intervalMs: 1_500 }), `the storefront /software/${plan.productId} shows the new price after revalidation`);
  // Restore the seed price.
  check(await savePlanPrice(page, oldRupees), "the original price is restored", await toasts(page));
  check(await priceIs(plan.pricePaise), "the plan's price is back in the database");
  check(await waitFor(async () => !shown(await storefrontHtml(plan.productId)), { timeoutMs: 30_000, intervalMs: 1_500 }), "the storefront drops the changed price again");
}

async function adminRelease(page, fx) {
  const version = `0.0.${10_000 + Math.floor(Math.random() * 89_999)}`;
  await go(page, "/admin/releases?new=release");
  const drawer = drawerOf(page);
  await drawer.getByLabel("Product").waitFor({ timeout: 30_000 });
  await drawer.getByLabel("Product").selectOption(fx.entitledProductId);
  await drawer.getByLabel("Version").fill(version);
  await drawer.getByLabel("Release notes").fill(`Admin console check ${TAG} (removed after the run)`);
  await drawer.getByRole("button", { name: "Create draft", exact: true }).click();
  check(await waitForToast(page, "Draft release created"), `the Administrator creates a draft release v${version}`, await toasts(page));
  await page.waitForURL((u) => new URL(u).searchParams.has("id"), { timeout: 30_000 });
  const releaseId = new URL(page.url()).searchParams.get("id");
  remember("releaseIds", releaseId);
  const draft = drawerOf(page);
  const upload = draft.getByRole("button", { name: "Upload the Windows installer", exact: true });
  await upload.waitFor({ timeout: 30_000 });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 15_000 }), upload.click()]);
  await chooser.setFiles({ name: `AxiomaticCheck-${version}.exe`, mimeType: "application/octet-stream", buffer: Buffer.from(`SAMPLE installer for the admin console check ${TAG}\n`) });
  check(await waitForToast(page, "Windows installer uploaded", 60_000), "a small Windows installer uploads (presigned PUT, server SHA-256)", await toasts(page));
  const file = await one(`SELECT "sizeBytes", sha256 FROM "ReleaseFile" WHERE "releaseId" = $1`, [releaseId]);
  check(file && /^[0-9a-f]{64}$/.test(file.sha256 ?? ""), "the installer row has a SHA-256", JSON.stringify(file));
  // Remove installer and Delete draft are destructive: both refuse to confirm without a reason (then cancelled).
  await draft.getByRole("button", { name: "Remove the Windows installer", exact: true }).click();
  await cancelDialog(await checkReasonGate(page, "releases.remove_installer (dialog)", "Remove"));
  await draft.getByRole("button", { name: "Delete draft", exact: true }).click();
  await cancelDialog(await checkReasonGate(page, "releases.delete (dialog)", "Delete draft"));
  const kept = await one(`SELECT r.status, count(f.id)::int AS files FROM "Release" r LEFT JOIN "ReleaseFile" f ON f."releaseId" = r.id WHERE r.id = $1 GROUP BY r.status`, [releaseId]);
  check(kept?.status === "DRAFT" && kept.files === 1, "cancelling Remove and Delete draft keeps the draft and its installer", JSON.stringify(kept));
  await draft.getByRole("button", { name: "Publish release", exact: true }).click();
  const dialog = alertOf(page);
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  check(await waitForToast(page, "Release published"), "the release is published", await toasts(page));
  check((await one(`SELECT status FROM "Release" WHERE id = $1`, [releaseId]))?.status === "PUBLISHED", "the release is PUBLISHED in the database");
  const href = `/account/software?release=${releaseId}`;
  const notified = await waitFor(
    () => one(`SELECT n.id FROM "Notification" n JOIN "AccountMember" m ON m."userId" = n."userId" WHERE n.href = $1 AND m."accountId" = $2 LIMIT 1`, [href, fx.customer.accountId]),
    { timeoutMs: 45_000 },
  );
  check(Boolean(notified), `an entitled account (${fx.customer.legalName}) gets the in-app update notification`);
  // Withdraw it again (with a reason), so the storefront and portal never keep the test release.
  await drawerOf(page).getByRole("button", { name: "Withdraw release", exact: true }).click();
  await confirmWith(page, { reason: `Admin console check ${TAG}`, confirm: "Withdraw release" });
  check(await waitForToast(page, "Release withdrawn"), "the release is withdrawn with a reason", await toasts(page));
}

/** An empty category made for the run is deleted in the category dialog: a reason is required and audited. */
async function adminCategory(page, fx) {
  if (!fx.categoryStyle) {
    console.info("note: no category in the data to copy a tone and icon from; skipped the category delete journey");
    return;
  }
  const id = `chk-${TAG}`;
  const name = `Admin check ${TAG}`;
  const res = await api(page, "POST", "/api/admin/categories", { id, name, blurb: null, tone: fx.categoryStyle.tone, icon: fx.categoryStyle.icon, sortOrder: 9999 });
  check(res.status === 201, `the Administrator creates an empty category ${id} (API)`, `${res.status} ${JSON.stringify(res.body?.error ?? "")}`);
  if (res.status !== 201) return;
  remember("categoryIds", id);
  await go(page, `/admin/products?category=${encodeURIComponent(id)}`);
  const dialog = page.getByRole("dialog").filter({ hasText: `Edit ${name}` }).last();
  const del = dialog.getByRole("button", { name: "Delete category", exact: true });
  await del.waitFor({ timeout: 30_000 });
  check((await actionState(del)) === "enabled", "Delete category is offered for an empty category", await actionState(del));
  await del.click();
  const confirm = await checkReasonGate(page, "categories.delete (dialog)", "Delete category");
  const calls = [];
  const onResponse = (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/admin/categories/")) calls.push(`${r.request().method()} ${r.status()}`);
  };
  page.on("response", onResponse);
  await confirm.getByRole("button", { name: "Delete category", exact: true }).click();
  let deleted = await waitForToast(page, "Category deleted", 10_000);
  const reasonField = alertOf(page).getByLabel("Reason (saved to the audit log)");
  const typedBefore = await reasonField.inputValue({ timeout: 1_000 }).catch(() => null);
  if (!deleted && calls.length === 0 && typedBefore !== null) {
    // The dialog is still open and nothing was sent: a development-server refresh (another file changed) reset its
    // fields after the gate check. Type the reason once more; a button that never submits still fails below.
    console.info(`note: category delete sent nothing (reason field now ${typedBefore ? "filled" : "empty"}); confirming once more`);
    await reasonField.fill(`Admin console check ${TAG}`);
    await alertOf(page).getByRole("button", { name: "Delete category", exact: true }).click();
    deleted = await waitForToast(page, "Category deleted");
  }
  page.off("response", onResponse);
  const dialogText = await alertOf(page).innerText({ timeout: 1_000 }).catch(() => "closed");
  check(deleted, "the empty category is deleted with a reason", `toasts ${JSON.stringify(await toasts(page))}; calls ${calls.join(", ")}; dialog: ${dialogText.slice(0, 300)}`);
  check(!(await one(`SELECT 1 FROM "Category" WHERE id = $1`, [id])), "the category is gone");
  const audit = await all(`SELECT action, reason FROM "AuditLog" WHERE "targetId" = $1 AND "actorId" = $2 AND action = 'Deleted category'`, [id, fx.staff.admin]);
  check(audit.length === 1 && audit[0].reason === `Admin console check ${TAG}`, 'exactly one "Deleted category" audit row carries the reason', JSON.stringify(audit));
}

async function adminCoupon(page) {
  const code = `CHK${TAG.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-7)}`;
  await go(page, "/admin/coupons?new=1");
  const drawer = drawerOf(page);
  await drawer.getByLabel("Code").waitFor({ timeout: 30_000 });
  await drawer.getByLabel("Code").fill(code);
  await drawer.getByLabel("Percent off").fill("5");
  await drawer.getByLabel("Checkout label").fill("Admin check: 5% off");
  await drawer.getByLabel("Starts").fill(istDate(0));
  await drawer.getByLabel("Ends").fill(istDate(30));
  await drawer.getByRole("button", { name: "Create coupon", exact: true }).click();
  check(await waitForToast(page, "Coupon created"), `the Administrator creates coupon ${code} (paused)`, await toasts(page));
  remember("couponCodes", code);
  check((await one(`SELECT active FROM "Coupon" WHERE code = $1`, [code]))?.active === false, "a new coupon starts paused");
  await page.waitForURL((u) => new URL(u).searchParams.get("id") === code, { timeout: 30_000 });
  await drawerOf(page).getByRole("button", { name: "Activate", exact: true }).click();
  check(await waitForToast(page, "Coupon active"), "the coupon is activated", await toasts(page));
  await drawerOf(page).getByRole("button", { name: "Pause", exact: true }).click();
  check(await waitForToast(page, "Coupon paused"), "the coupon is paused", await toasts(page));
  check((await one(`SELECT active FROM "Coupon" WHERE code = $1`, [code]))?.active === false, "the coupon is paused in the database");
  await drawerOf(page).getByRole("button", { name: "Delete", exact: true }).click();
  await confirmWith(page, { reason: `Admin console check ${TAG}`, typed: code, confirm: "Delete coupon" });
  check(await waitForToast(page, "Coupon deleted"), "the unused coupon is deleted with a reason and the typed code", await toasts(page));
  check(!(await one(`SELECT 1 FROM "Coupon" WHERE code = $1`, [code])), "the coupon is gone");
}

async function adminJourney(fx) {
  current = "admin";
  const s = await open({ who: "admin", width: 1280 });
  const { page } = s;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      check(false, `${name} completed`, errText(error));
      await shot(page, `admin-${name.replace(/[^a-z0-9]+/gi, "-")}-error`);
    }
  };
  try {
    await step("plan price", () => adminPlanPrice(page, fx));
    await step("release", () => adminRelease(page, fx));
    await step("category", () => adminCategory(page, fx));
    await step("coupon", () => adminCoupon(page));
  } finally {
    await close(s, "admin journey");
  }
}

// ---------- support ----------
async function supportJourney(fx) {
  current = "support";
  const customer = await open({ who: "customer", width: 1280 });
  const s = await open({ who: "support", width: 1280 });
  const { page } = s;
  try {
    // Priya opens a ticket in the portal (API, as the portal form does).
    await go(customer.page, "/account/tickets");
    const opened = await api(customer.page, "POST", "/api/account/tickets", {
      productId: fx.entitledProductId,
      subject: `Admin check ${TAG}: printer setup`,
      body: "The invoice printer stopped working after the update. Admin console check, removed after the run.",
    });
    const ticketId = opened.body?.ticket?.id ?? null;
    check(opened.status === 201 && ticketId, "Priya opens a ticket in the portal", `${opened.status} ${opened.body?.error?.code ?? ""}`);
    if (!ticketId) return;
    remember("ticketIds", ticketId);

    const reply = `Hi Priya, please reinstall the printer driver (check ${TAG}).`;
    const note = `Internal: customer on old driver, check ${TAG}.`;
    await go(page, `/admin/tickets?id=${encodeURIComponent(ticketId)}`);
    const drawer = drawerOf(page);
    await drawer.getByLabel("Message", { exact: true }).waitFor({ timeout: 30_000 });
    await drawer.getByLabel("Message", { exact: true }).fill(reply);
    await drawer.getByRole("button", { name: "Send reply", exact: true }).click();
    check(await waitForToast(page, "Reply sent"), "Support replies to the ticket", await toasts(page));
    await drawerOf(page).getByRole("switch", { name: "Internal note" }).click();
    await drawerOf(page).getByLabel("Note", { exact: true }).fill(note);
    await drawerOf(page).getByRole("button", { name: "Add note", exact: true }).click();
    check(await waitForToast(page, "Internal note added"), "Support adds an internal note", await toasts(page));

    const portal = await api(customer.page, "GET", `/api/account/tickets/${encodeURIComponent(ticketId)}`);
    const portalJson = JSON.stringify(portal.body ?? {});
    check(portal.status === 200 && portalJson.includes(reply), "the portal API shows the staff reply to Priya", portal.status);
    check(!portalJson.includes(note), "the portal API never shows the internal note");
    await go(customer.page, `/account/tickets/${encodeURIComponent(ticketId)}`);
    const portalText = await customer.page.locator("main").innerText();
    check(portalText.includes(reply) && !portalText.includes(note), "the portal ticket page shows the reply and not the note");
    const denied = await open({ who: "finance", width: 1280 });
    try {
      await go(denied.page, "/admin");
      const res = await api(denied.page, "GET", `/api/admin/tickets/${encodeURIComponent(ticketId)}`);
      check(res.status === 403, "Finance cannot read the ticket (403)", res.status);
    } finally {
      await denied.ctx.close();
    }

    // Suspend and reinstate a license, each with a reason.
    const L = fx.license.id;
    remember("touchedLicenseIds", L);
    remember("accountIds", fx.license.accountId);
    await go(page, `/admin/licenses?id=${encodeURIComponent(L)}`);
    await drawerOf(page).getByRole("button", { name: "Suspend", exact: true }).waitFor({ timeout: 30_000 });
    await drawerOf(page).getByRole("button", { name: "Suspend", exact: true }).click();
    await confirmWith(page, { reason: `Admin console check ${TAG}: payment dispute`, confirm: "Suspend" });
    check(await waitFor(async () => (await one(`SELECT status FROM "License" WHERE id = $1`, [L]))?.status === "SUSPENDED"), `Support suspends ${L} with a reason`);
    await drawerOf(page).getByRole("button", { name: "Reinstate", exact: true }).waitFor({ timeout: 30_000 });
    await drawerOf(page).getByRole("button", { name: "Reinstate", exact: true }).click();
    await confirmWith(page, { reason: `Admin console check ${TAG}: dispute resolved`, confirm: "Reinstate" });
    check(await waitFor(async () => (await one(`SELECT status FROM "License" WHERE id = $1`, [L]))?.status === "ACTIVE"), `Support reinstates ${L} with a reason`);
    const rows = await all(`SELECT action, reason FROM "AuditLog" WHERE "targetId" = $1 AND "actorId" = $2 ORDER BY "createdAt"`, [L, fx.staff.support]);
    const fresh = rows.slice(-2);
    check(fresh.length === 2 && fresh.every((r) => (r.reason ?? "").includes(TAG)), "one audit row with the reason for each action", JSON.stringify(fresh));
  } catch (error) {
    check(false, "support journey completed", errText(error));
    await shot(page, "support-error");
  } finally {
    await close(customer, "support journey (customer)");
    await close(s, "support journey");
  }
}

// ---------- finance ----------
/** Priya buys one license with the mock provider (success); resolves to { orderId, licenseId } once it is PAID. */
async function buyAsCustomer(customerPage, fx) {
  // Compile the webhook and return routes first: a dev server busy compiling them can miss the mock provider's delivery.
  await fetch(`${BASE}/api/webhooks/payments/mock`, { method: "GET" }).catch(() => {});
  await go(customerPage, "/pricing");
  const start = await api(customerPage, "POST", "/api/checkout/orders", {
    items: [{ planId: fx.buyPlan.id, qty: 1 }],
    billing: { name: "Priya Sharma", email: USERS.customer.email, phone: "9820012345", business: fx.customer.legalName, address: "12 MG Road", city: "Pune", state: "Maharashtra", pin: "411001" },
    acceptTerms: true,
  });
  const orderId = start.body?.orderId ?? null;
  if (start.status !== 201 || !orderId) throw new Error(`order creation answered ${start.status} ${start.body?.error?.code ?? ""}`);
  remember("orderIds", orderId);
  await go(customerPage, start.body.checkout.url);
  await customerPage.getByRole("button", { name: /succeeds/ }).click();
  await customerPage.waitForURL(/\/orders\/AX-/, { timeout: 60_000 });
  // payment.captured arrives ~1.5 s later; a failed delivery is retried after 5 s and 20 s (lib/payments/mock-delivery.ts).
  const paid = await waitFor(() => one(`SELECT status FROM "Order" WHERE id = $1 AND status = 'PAID'`, [orderId]), { timeoutMs: 60_000 });
  check(Boolean(paid), `Priya's mock payment marks ${orderId} PAID (verified webhook)`);
  const license = await waitFor(() => one(`SELECT id FROM "License" WHERE "orderId" = $1`, [orderId]), { timeoutMs: 30_000 });
  for (const row of await all(`SELECT id FROM "License" WHERE "orderId" = $1`, [orderId])) remember("licenseIds", row.id);
  return { orderId, licenseId: license?.id ?? null };
}

async function financeJourney(fx) {
  current = "finance";
  const customer = await open({ who: "customer", width: 1280 });
  const s = await open({ who: "finance", width: 1280 });
  const { page } = s;
  try {
    remember("accountIds", fx.customer.accountId);
    const { orderId, licenseId } = await buyAsCustomer(customer.page, fx);
    check(Boolean(licenseId), "the order issued a license");
    if (!licenseId) return;

    // Finance cannot revoke licenses: the button is disabled with the rbac tooltip and the API answers 403.
    await go(page, `/admin/licenses?id=${encodeURIComponent(licenseId)}`);
    const revoke = drawerOf(page).getByRole("button", { name: "Revoke", exact: true });
    await revoke.waitFor({ timeout: 30_000 });
    check((await actionState(revoke)) === "disabled", "Finance sees Revoke disabled");
    await revoke.hover();
    const tip = await page.getByRole("tooltip").first().innerText({ timeout: 5_000 }).catch(() => "");
    check(tip.includes(rbac.requiresLabel("licenses.revoke")), `the tooltip says "${rbac.requiresLabel("licenses.revoke")}"`, tip);
    const denied = await api(page, "POST", `/api/admin/licenses/${encodeURIComponent(licenseId)}/revoke`, { reason: `Admin check ${TAG}`, confirmId: licenseId });
    check(denied.status === 403 && denied.body?.error?.code === "forbidden", "Finance's revoke API call answers 403 forbidden", `${denied.status} ${denied.body?.error?.code ?? ""}`);

    // Refund with a reason and the typed order id.
    await go(page, `/admin/orders?id=${encodeURIComponent(orderId)}`);
    const refundButton = drawerOf(page).getByRole("button", { name: "Issue refund", exact: true });
    await refundButton.waitFor({ timeout: 30_000 });
    await refundButton.click();
    await confirmWith(page, { reason: `Admin console check ${TAG}: customer cancelled`, typed: orderId, confirm: "Issue refund" });
    check(await waitForToast(page, "Refund issued"), "Finance issues the refund (\"Refund issued · licenses revoked\")", await toasts(page));
    const refund = await waitFor(() => one(`SELECT r."creditNoteNo", r.status FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" WHERE p."orderId" = $1`, [orderId]));
    check(/^[A-Z0-9-]{1,3}\/\d{2}-\d{2}\/\d{4}$/.test(refund?.creditNoteNo ?? ""), `the refund carries a credit note number (${refund?.creditNoteNo ?? "none"})`);
    check((await one(`SELECT status FROM "License" WHERE id = $1`, [licenseId]))?.status === "REVOKED", "the refund revokes the license");
    const refunded = await waitFor(() => one(`SELECT 1 FROM "Order" WHERE id = $1 AND status = 'REFUNDED'`, [orderId]), { timeoutMs: 45_000 });
    check(Boolean(refunded), "refund.processed (mock webhook) marks the order REFUNDED");
    const audit = await one(`SELECT reason FROM "AuditLog" WHERE "targetId" = $1 AND "actorId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [orderId, fx.staff.finance]);
    check((audit?.reason ?? "").includes(TAG), "the refund's audit row keeps the reason");
    await go(page, `/admin/orders?id=${encodeURIComponent(orderId)}`);
    await drawerOf(page).waitFor({ timeout: 30_000 });
    const drawerText = await drawerOf(page).innerText();
    check(refund?.creditNoteNo ? drawerText.includes(refund.creditNoteNo) : false, "the order drawer lists the credit note");
    await go(customer.page, `/account/licenses/${encodeURIComponent(licenseId)}`);
    check((await customer.page.locator("main").innerText()).includes("Revoked"), "Priya's portal shows the license as Revoked");
  } catch (error) {
    check(false, "finance journey completed", errText(error));
    await shot(page, "finance-error");
  } finally {
    await close(customer, "finance journey (customer)");
    await close(s, "finance journey");
  }
}

// ---------- owner ----------
const inviteeStates = [];

async function ownerInvite(page) {
  const email = `check-staff-${TAG}@example.test`;
  remember("emails", email);
  await go(page, "/admin/staff");
  await page.getByRole("button", { name: "Invite staff", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({ visible: true }).last();
  await dialog.getByLabel("Work email").fill(email);
  await dialog.getByRole("radio", { name: /^Support\b/ }).check();
  const before = new Set((await mailbox()).map((m) => m.id));
  await dialog.getByRole("button", { name: "Send invitation", exact: true }).click();
  check(await waitForToast(page, `Invitation sent to ${email}`), "the Owner invites a staff member (Support)", await toasts(page));
  const invitee = await one(`SELECT id, "staffStatus", "staffRole" FROM "User" WHERE email = $1`, [email]);
  if (invitee) remember("staffUserIds", invitee.id);
  check(invitee?.staffStatus === "INVITED" && invitee?.staffRole === "SUPPORT", "the invited staff member is pending as Support", JSON.stringify(invitee));
  if (!invitee) return null;

  const mail = await waitForMail(email, /invited you to the Axiomatic admin console/, { exclude: before });
  const fresh = await open({ width: 1280 });
  try {
    await go(fresh.page, `/dev/mailbox?id=${encodeURIComponent(mail.id)}`);
    const text = (await fresh.page.locator("pre").first().textContent()) ?? "";
    const link = /(https?:\/\/[^\s"<>]+\/staff-invite\?token=[^\s"<>]+)/.exec(text)?.[1];
    check(Boolean(link), "the invitation email carries a /staff-invite link");
    if (!link) return invitee.id;
    const url = new URL(link);
    await go(fresh.page, url.pathname + url.search);
    await fresh.page.getByLabel("Full name").fill("Check Staff");
    await fresh.page.getByLabel("Password", { exact: true }).fill(`Ck${randomBytes(9).toString("hex")}7!`);
    await Promise.all([
      fresh.page.waitForURL((u) => new URL(u).pathname.startsWith("/admin"), { timeout: 90_000 }),
      fresh.page.getByRole("button", { name: "Accept invitation", exact: true }).click(),
    ]);
    await fresh.page.locator("h1").first().waitFor({ timeout: 60_000 });
    check(true, "the invitation is accepted in a fresh browser and lands in the admin console");
    inviteeStates.push(await fresh.ctx.storageState());
    check((await one(`SELECT "staffStatus" FROM "User" WHERE id = $1`, [invitee.id]))?.staffStatus === "ACTIVE", "the new staff member is active");
  } finally {
    await close(fresh, "invitee context");
  }
  return invitee.id;
}

async function ownerJourney(fx) {
  current = "owner";
  const s = await open({ who: "owner", width: 1280, downloads: true });
  const { page } = s;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      check(false, `${name} completed`, errText(error));
      await shot(page, `owner-${name.replace(/[^a-z0-9]+/gi, "-")}-error`);
    }
  };
  try {
    let inviteeId = null;
    await step("invite", async () => {
      inviteeId = await ownerInvite(page);
    });
    await step("change role", async () => {
      if (!inviteeId) return;
      await go(page, `/admin/staff?id=${encodeURIComponent(inviteeId)}`);
      await drawerOf(page).getByRole("button", { name: "Assign Finance", exact: true }).click();
      await confirmWith(page, { reason: `Admin console check ${TAG}: moves to accounts`, confirm: "Change role" });
      check(await waitForToast(page, "Role updated"), "the Owner changes the role with a reason", await toasts(page));
      const row = await one(`SELECT "staffRole", "twoStepEnabled" FROM "User" WHERE id = $1`, [inviteeId]);
      check(row?.staffRole === "FINANCE" && row?.twoStepEnabled === true, "the member is now Finance with two-step sign-in on", JSON.stringify(row));
    });
    await step("settings", async () => {
      await go(page, "/admin/settings");
      const form = page.locator("#settings-business");
      const field = form.getByLabel("Support hours");
      await field.waitFor({ timeout: 30_000 });
      const original = await field.inputValue();
      const changed = `Mon–Sat 9:30 am – 6:30 pm (check ${TAG})`;
      await field.fill(changed);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      check(await waitForToast(page, "saved"), "the Owner saves a business setting", await toasts(page));
      const row = await one(`SELECT action, detail FROM "AuditLog" WHERE "actorId" = $1 AND action = 'Updated settings' ORDER BY "createdAt" DESC LIMIT 1`, [fx.staff.owner]);
      check((row?.detail ?? "").includes(TAG), "the settings change is audited (old -> new)", JSON.stringify(row));
      await field.fill(original);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      check(await waitForToast(page, "saved"), "the original setting is restored", await toasts(page));
    });
    await step("audit export", async () => {
      await go(page, "/admin/audit");
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        page.getByRole("button", { name: "CSV", exact: true }).first().click(),
      ]);
      const file = await download.path();
      const csv = file ? fs.readFileSync(file, "utf8") : "";
      check(download.suggestedFilename().endsWith(".csv"), `the audit log CSV downloads (${download.suggestedFilename()})`);
      check(csv.startsWith("\uFEFF") && csv.split(/\r?\n/).filter(Boolean).length > 1, "the CSV has a BOM and rows");
      check(await waitForToast(page, "Exported"), "the export toast names the rows", await toasts(page));
      const row = await one(`SELECT target FROM "AuditLog" WHERE "actorId" = $1 AND action = 'Exported report' ORDER BY "createdAt" DESC LIMIT 1`, [fx.staff.owner]);
      check(Boolean(row), "the export itself is audited (\"Exported report\")", JSON.stringify(row));
    });
  } finally {
    await close(s, "owner journey");
  }
}

// ---------- clean-up (only what this run created, by id) ----------
const STORAGE_ROOT = path.resolve(ENV.STORAGE_LOCAL_DIR || ".storage");
function removeStored(key) {
  if (!key) return;
  const full = path.resolve(STORAGE_ROOT, ...String(key).split("/"));
  if (!full.startsWith(STORAGE_ROOT + path.sep)) return;
  fs.rmSync(full, { force: true });
  // The local driver leaves the object's folders behind; remove the ones that are now empty (never the root).
  for (let dir = path.dirname(full); dir.startsWith(STORAGE_ROOT + path.sep); dir = path.dirname(dir)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
  }
}

async function cleanUp(fx) {
  current = "cleanup";
  if (KEEP_DATA || !LOCAL) {
    console.info(`note: ${KEEP_DATA ? "--keep-data" : "remote server"}: created records kept: ${JSON.stringify(created)}`);
    return;
  }
  const staffIds = [...Object.values(fx.staff), ...created.staffUserIds];
  const accountIds = [...new Set([fx.customer.accountId, ...created.accountIds])];
  const memberIds = (await all(`SELECT "userId" FROM "AccountMember" WHERE "accountId" = ANY($1)`, [accountIds])).map((r) => r.userId);
  const memberEmails = (await all(`SELECT email FROM "User" WHERE id = ANY($1)`, [memberIds])).map((r) => r.email);
  const ownIds = [...created.orderIds, ...created.licenseIds, ...created.releaseIds, ...created.ticketIds, ...created.couponCodes, ...created.staffUserIds, ...created.categoryIds];
  const targets = [...ownIds, ...created.touchedLicenseIds, ...created.targets];
  const licenseIds = [...created.licenseIds, ...created.touchedLicenseIds];
  const hrefs = created.releaseIds.map((id) => `/account/software?release=${id}`);
  const patterns = ownIds.map((id) => `%${id}%`);
  const emails = [...STAFF_KEYS.map((k) => USERS[k].email), ...memberEmails, ...created.emails];

  const del = {
    AuditLog: await newIds("AuditLog", `"actorId" = ANY($1) OR "targetId" = ANY($2)`, [staffIds, targets]),
    AccountActivity: await newIds("AccountActivity", `"accountId" = ANY($1)`, [accountIds]),
    Notification: await newIds("Notification", `"userId" = ANY($1) OR href = ANY($2)`, [[...memberIds, ...staffIds], hrefs]),
    OutboxEmail: await newIds("OutboxEmail", `"to" = ANY($1) OR "dedupeKey" LIKE ANY($2)`, [emails, patterns]),
    LicenseEvent: await newIds("LicenseEvent", `"licenseId" = ANY($1)`, [licenseIds]),
  };
  const files = [];
  await db.query("BEGIN");
  try {
    for (const [table, ids] of Object.entries(del)) if (ids.length) await db.query(`DELETE FROM "${table}" WHERE id = ANY($1)`, [ids]);
    // Ticket (messages, uploads).
    const msgs = (await all(`SELECT id FROM "TicketMessage" WHERE "ticketId" = ANY($1)`, [created.ticketIds])).map((r) => r.id);
    for (const u of await all(`SELECT "storageKey" FROM "Upload" WHERE "ticketMessageId" = ANY($1)`, [msgs])) files.push(u.storageKey);
    await db.query(`DELETE FROM "Upload" WHERE "ticketMessageId" = ANY($1)`, [msgs]);
    await db.query(`DELETE FROM "TicketMessage" WHERE "ticketId" = ANY($1)`, [created.ticketIds]);
    await db.query(`DELETE FROM "SupportTicket" WHERE id = ANY($1)`, [created.ticketIds]);
    // Order, its license, payments, refund, invoice and webhooks.
    const O = created.orderIds;
    const L = created.licenseIds;
    await db.query(`DELETE FROM "DownloadEvent" WHERE "licenseId" = ANY($1)`, [L]);
    await db.query(`DELETE FROM "DeviceActivation" WHERE "licenseId" = ANY($1)`, [L]);
    await db.query(`DELETE FROM "LicenseEvent" WHERE "licenseId" = ANY($1)`, [L]);
    await db.query(`DELETE FROM "OrderItem" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "Refund" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "orderId" = ANY($1))`, [O]);
    for (const i of await all(`SELECT "pdfKey" FROM "Invoice" WHERE "orderId" = ANY($1)`, [O])) files.push(i.pdfKey);
    await db.query(`DELETE FROM "Invoice" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "WebhookDelivery" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "WebhookEvent" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "CouponRedemption" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "License" WHERE id = ANY($1)`, [L]);
    await db.query(`DELETE FROM "Payment" WHERE "orderId" = ANY($1)`, [O]);
    await db.query(`DELETE FROM "Order" WHERE id = ANY($1)`, [O]);
    // Release and its installers.
    for (const f of await all(`SELECT "storageKey" FROM "ReleaseFile" WHERE "releaseId" = ANY($1)`, [created.releaseIds])) files.push(f.storageKey);
    await db.query(`DELETE FROM "DownloadEvent" WHERE "fileId" IN (SELECT id FROM "ReleaseFile" WHERE "releaseId" = ANY($1))`, [created.releaseIds]);
    await db.query(`DELETE FROM "ReleaseFile" WHERE "releaseId" = ANY($1)`, [created.releaseIds]);
    await db.query(`DELETE FROM "Release" WHERE id = ANY($1)`, [created.releaseIds]);
    // A category left behind by a failed journey (only while no product uses it).
    await db.query(`DELETE FROM "Category" WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."categoryId" = "Category".id)`, [created.categoryIds]);
    // A coupon left behind by a failed journey (unused, so nothing references it).
    await db.query(`DELETE FROM "Coupon" WHERE code = ANY($1) AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."couponCode" = "Coupon".code)`, [created.couponCodes]);
    // The invited staff member (sessions and tokens cascade).
    await db.query(`DELETE FROM "User" WHERE id = ANY($1) AND kind = 'STAFF'`, [created.staffUserIds]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    check(false, "clean-up removed the records this run created", errText(error));
    return;
  }
  for (const key of files) removeStored(key);
  const counts = Object.fromEntries(Object.entries(del).map(([t, ids]) => [t, ids.length]));
  console.info(`Removed: orders ${created.orderIds.join(",") || "none"}, licenses ${created.licenseIds.join(",") || "none"}, releases ${created.releaseIds.length}, tickets ${created.ticketIds.join(",") || "none"}, staff ${created.staffUserIds.length}, files ${files.filter(Boolean).length}, rows ${JSON.stringify(counts)}`);
  check(true, "clean-up removed the records this run created");
}

// ---------- main ----------
async function reasonsStep(fx) {
  current = "reasons";
  const s = await open({ who: "owner", width: 1280 });
  try {
    await go(s.page, "/admin");
    await reasonsJourney(s.page, fx);
  } catch (error) {
    check(false, "reasons check completed", errText(error));
  } finally {
    await close(s, "reasons");
  }
}

async function main() {
  await db.connect();
  browser = await chromium.launch({ channel: "chrome", headless: opt.headed !== "true" });
  let fx = null;
  try {
    await resetSharedIpBuckets();
    fx = await loadFixtures();
    await takeSnapshot();
    const needed = new Set(ONLY.has("pages") ? ROLES : []);
    if (ONLY.has("reasons") || ONLY.has("owner")) needed.add("owner");
    if (ONLY.has("admin")) needed.add("admin");
    if (ONLY.has("support")) ["support", "finance", "customer"].forEach((w) => needed.add(w));
    if (ONLY.has("finance")) ["finance", "customer"].forEach((w) => needed.add(w));
    for (const who of [...STAFF_KEYS, "customer"]) if (needed.has(who)) await signInViaUi(who);
    if (ONLY.has("pages")) await runPages(fx);
    if (ONLY.has("reasons") && STATES.owner) await reasonsStep(fx);
    if (ONLY.has("admin") && STATES.admin) await adminJourney(fx);
    if (ONLY.has("support") && STATES.support && STATES.customer && STATES.finance) await supportJourney(fx);
    if (ONLY.has("finance") && STATES.finance && STATES.customer) await financeJourney(fx);
    if (ONLY.has("owner") && STATES.owner) await ownerJourney(fx);
  } catch (error) {
    check(false, "the run completed", errText(error));
  } finally {
    if (fx) await cleanUp(fx).catch((error) => check(false, "clean-up removed the records this run created", errText(error)));
    await signOutAll(inviteeStates).catch(() => {});
    await browser.close().catch(() => {});
    await db.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  const byScenario = {};
  for (const r of results) {
    const key = r.scenario.split(" ")[0];
    byScenario[key] ??= { pass: 0, fail: 0 };
    byScenario[key][r.ok ? "pass" : "fail"] += 1;
  }
  report.finishedAt = new Date().toISOString();
  report.summary = { checks: results.length, failed: failed.length, byScenario };
  report.failures = failed;
  if (opt.json) fs.writeFileSync(path.resolve(opt.json), JSON.stringify(report, null, 2));
  console.info(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const [scenario, n] of Object.entries(byScenario)) console.info(`  ${scenario}: ${n.pass} passed, ${n.fail} failed`);
  if (failed.length) {
    console.info("\nFailures:");
    for (const f of failed) console.info(`  [${f.scenario}] ${f.label}${f.detail !== undefined ? ` -> ${String(f.detail).slice(0, 400)}` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

await main();
