/**
 * Purchase-journey end-to-end check (dev tool). Drives the real app in the locally installed Google Chrome
 * (Playwright, channel "chrome") with the mock payment provider:
 *
 *   node scripts/check-purchase.mjs [--base=http://localhost:3000] [--only=a,b,c,d,e,f] [--shots=<dir>] [--headed]
 *     [--keep-limits]
 *
 *   a  Guest buys Medical Store Billing (annual) with a Maharashtra GSTIN and WELCOME10 -> mock success -> the order
 *      page reaches PAID and shows the full key once; a reload shows it masked; the invoice PDF downloads.
 *   b  Register with the same email (the order page's "Create account") -> code from /dev/mailbox -> verify -> the
 *      order and its license now belong to the new account (/api/me + database).
 *   c  Inter-state checkout shows IGST; the expired coupon MONSOON25 shows the expiry message.
 *   d  Pending -> simulate the bank (ok) -> PAID; failed -> "Try again" keeps the cart -> success; cancel -> canceled;
 *      a failure reported just after the order page opened still shows.
 *   e  Sign-in lockout: five wrong passwords, then even the right one gets 429 with Retry-After.
 *   f  Two-step sign-in of a staff user with the emailed code from /dev/mailbox.
 *
 * Needs a development server with PAYMENT_PROVIDER=mock and EMAIL_TRANSPORT=console (codes come from /dev/mailbox),
 * and DATABASE_URL in .env.local for read-only checks. With TRUSTED_PROXY_HOPS=0 every local request shares the
 * "unknown" IP rate-limit buckets, so the script first deletes those rows (local servers only; --keep-limits skips it).
 * Creates throwaway customers check-<tag>@example.test and a few orders. Never prints passwords, codes, keys or tokens.
 * Exit code 1 when any check fails.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import pg from "pg";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const BASE = new URL(opt.base ?? process.env.PURCHASE_BASE_URL ?? "http://localhost:3000").origin;
const ONLY = new Set((opt.only ?? "a,b,c,d,e,f").split(",").map((s) => s.trim()).filter(Boolean));
const SHOTS = opt.shots ? path.resolve(opt.shots) : null;
const HEADED = opt.headed === "true";
const KEY_RE_SRC = /\b[A-Z]{3}(?:-[A-HJ-NP-Z2-9]{4}){4}\b/.source;
const PAID_TITLE = "Payment confirmed — your software is ready";
const STAFF_EMAIL = "sneha@axiomatic.example";
const GSTIN_MH = "27ABCDE1234F1Z5";
const TAG = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const BUYER_EMAIL = `check-${TAG}@example.test`;
// Throwaway password for the customer this run registers (kept in memory only).
const BUYER_PASSWORD = `Chk${randomBytes(6).toString("hex")}9`;

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

const results = [];
let current = "";
function check(ok, label, detail) {
  results.push({ scenario: current, ok: Boolean(ok), label, detail });
  console.info(`${ok ? "PASS" : "FAIL"} [${current}] ${label}${!ok && detail !== undefined ? ` -> ${detail}` : ""}`);
  return Boolean(ok);
}

// ---------- database (read-only checks + local rate-limit reset) ----------
const db = new pg.Client({ connectionString: (ENV.DATABASE_URL ?? "").replace(/\?.*$/, "") });
async function one(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}
async function all(sql, params = []) {
  return (await db.query(sql, params)).rows;
}

/** Deletes the shared "unknown"-IP buckets (TRUSTED_PROXY_HOPS=0 in development), local servers only. */
async function resetSharedIpBuckets() {
  const host = new URL(BASE).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return;
  const unknown = createHash("sha256").update("unknown").digest("hex").slice(0, 32);
  const res = await db.query(`DELETE FROM "RateLimitBucket" WHERE "key" LIKE $1`, [`%:ip:${unknown}`]);
  console.info(`Cleared ${res.rowCount} shared local rate-limit bucket(s).`);
}

// ---------- browser ----------
let browser;
const EXPECTED_REFUSAL = /status of (401|403|404|409|410|422|429)\b/;

/** A fresh browser context (own cookies and storage). Uncaught page errors and 5xx responses are failures. */
async function open(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    // API refusals the flows provoke on purpose (wrong password, lockout, expired coupon) are logged by the browser.
    if (msg.type() === "error" && !EXPECTED_REFUSAL.test(msg.text())) problems.push(`console: ${msg.text().slice(0, 200)}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) problems.push(`${res.status()} ${res.url().replace(BASE, "").replace(/([?&]t=)[^&]+/, "$1…")}`);
  });
  return { ctx, page, problems };
}

async function close({ ctx, problems }, label) {
  check(problems.length === 0, `${label}: no page errors, console errors or 5xx responses`, problems.join(" | "));
  await ctx.close();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // License keys render in <code>: masked so a screenshot never stores a full key.
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, mask: [page.locator("code")] }).catch(() => {});
}

const h1 = (page, name, timeout = 30_000) => page.getByRole("heading", { level: 1, name }).waitFor({ timeout });

/** Text of the page without hidden elements; used to look for full or masked keys. */
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const countKeys = (text) => (text.match(new RegExp(KEY_RE_SRC, "g")) ?? []).length;

// ---------- /dev/mailbox ----------
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** Messages in the dev mailbox, newest first: { id, subject, to }. */
async function mailbox() {
  const html = await (await fetch(`${BASE}/dev/mailbox`)).text();
  const re = /href="\/dev\/mailbox\?id=([^"]+)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => ({ id: decode(m[1]), subject: decode(m[2]), to: decode(m[3]) }));
}
const mailIds = async () => new Set((await mailbox()).map((m) => m.id));

async function waitForMail(to, subjectRe, seen, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await mailbox()).find((m) => m.to === to && subjectRe.test(m.subject) && !seen.has(m.id));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no email to ${to} matching ${subjectRe}`);
}

function codeFrom(subject) {
  const m = /(\d{6})/.exec(subject);
  if (!m) throw new Error("no 6-digit code in the subject");
  return m[1];
}

// ---------- cart, checkout and orders ----------
const CART_KEY = "axiomatic.cart";

async function setCart(page, items) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([key, list]) =>
      localStorage.setItem(key, JSON.stringify({ v: 1, items: list.map((i) => ({ maxQty: 1, kind: "NEW", targetLicenseId: null, ...i })) })),
    [CART_KEY, items],
  );
}

async function cartItems(page) {
  const raw = await page.evaluate((key) => localStorage.getItem(key), CART_KEY);
  try {
    return JSON.parse(raw ?? "null")?.items ?? [];
  } catch {
    return [];
  }
}

/** Fills the checkout form (guest). */
async function fillCheckout(page, { email, state, city, pin, gstin }) {
  await page.locator("#checkout-name").waitFor();
  await page.locator("#checkout-name").fill("Rahul Verma");
  await page.locator("#checkout-email").fill(email);
  await page.locator("#checkout-phone").fill("9820012345");
  await page.locator("#checkout-business").fill("Verma Medicals");
  await page.locator("#checkout-address").fill("12 MG Road");
  await page.locator("#checkout-city").fill(city);
  await page.locator("#checkout-pin").fill(pin);
  await page.locator("#checkout-state").selectOption(state);
  if (gstin) {
    await page.locator("#checkout-has-gstin").click();
    await page.locator("#checkout-gstin").fill(gstin);
  }
}

async function applyCoupon(page, code) {
  await page.locator("#checkout-coupon").fill(code);
  const quote = page.waitForResponse((r) => r.url().endsWith("/api/checkout/quote") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  return (await quote).status();
}

const summaryText = (page) => page.locator("aside[aria-label='Order summary']").innerText();

/** Agrees to the terms and pays; resolves on the mock checkout page. */
async function pay(page) {
  await page.locator("#checkout-agree").click();
  await page.getByRole("button", { name: /^Pay / }).click();
  await page.waitForURL(/\/dev\/mock-checkout/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Picks an outcome on the mock checkout page; resolves on the order page. */
async function mockOutcome(page, name) {
  await page.getByRole("button", { name }).click();
  await page.waitForURL(/\/orders\/AX-/, { timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
}

/** Creates an order through the API from the page (guest, Medical Store Billing annual); returns the 201 body. */
async function createOrderViaApi(page, { email, state = "Maharashtra", city = "Pune", pin = "411001" }) {
  await page.goto(`${BASE}/pricing`, { waitUntil: "domcontentloaded" });
  return page.evaluate(
    async ({ email, state, city, pin }) => {
      const csrf = await (await fetch("/api/csrf", { cache: "no-store" })).json();
      const res = await fetch("/api/checkout/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf.token },
        body: JSON.stringify({
          items: [{ planId: "med-annual", qty: 1 }],
          billing: { name: "Rahul Verma", email, phone: "9820012345", address: "12 MG Road", city, state, pin },
          acceptTerms: true,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`order creation answered ${res.status} ${body?.error?.code ?? ""}`);
      return body;
    },
    { email, state, city, pin },
  );
}

const orderRow = (id) =>
  one(
    `SELECT status, "accountId", "couponCode", "discountPaise", "cgstPaise", "sgstPaise", "igstPaise", "totalPaise",
            billing->>'gstin' AS gstin, billing->>'state' AS state FROM "Order" WHERE id = $1`,
    [id],
  );
const orderLicenses = (id) => all(`SELECT id, "accountId", "keyDeliveredAt" FROM "License" WHERE "orderId" = $1`, [id]);

// ---------- scenarios ----------
const state = { orderId: null, orderPath: null, buyer: null };

async function scenarioA() {
  const s = await open();
  const { page } = s;
  try {
    await page.goto(`${BASE}/software/medical-billing`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Add to cart ?: ?Annual license$/ }).first().click();
    await page.waitForFunction((key) => (localStorage.getItem(key) ?? "").includes("med-annual"), CART_KEY);
    check((await cartItems(page)).some((i) => i.planId === "med-annual"), "product page adds the annual plan to the cart");

    await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
    const cartLine = page.locator("main").getByRole("link", { name: /Medical Store Billing/ }).first();
    await cartLine.waitFor({ timeout: 15_000 }).catch(() => {});
    check(await cartLine.isVisible(), "cart lists Medical Store Billing");
    await page.getByRole("link", { name: "Continue to checkout" }).click();
    await page.waitForURL(/\/checkout$/);
    const csp = (await page.request.get(`${BASE}/checkout`)).headers()["content-security-policy"] ?? "";
    check(csp.includes("https://checkout.razorpay.com"), "the checkout page's CSP allows Razorpay Checkout.js");

    await fillCheckout(page, { email: BUYER_EMAIL, state: "Maharashtra", city: "Pune", pin: "411001", gstin: GSTIN_MH });
    check(await page.getByText("Valid format · Maharashtra").isVisible(), "GSTIN helper confirms the Maharashtra GSTIN");
    check((await applyCoupon(page, "WELCOME10")) === 200, "WELCOME10 quote succeeds");
    await page.getByRole("button", { name: /Remove coupon WELCOME10/ }).waitFor({ timeout: 10_000 });
    const summary = await summaryText(page);
    check(/Discount/.test(summary), "summary shows the coupon discount");
    check(/CGST 9%/.test(summary) && /SGST 9%/.test(summary) && !/IGST/.test(summary), "intra-state summary shows CGST + SGST");
    await shot(page, "a-checkout");

    await pay(page);
    const orderId = await mockOutcome(page, /succeeds/);
    state.orderId = orderId;
    state.orderPath = new URL(page.url()).pathname + new URL(page.url()).search;
    await h1(page, PAID_TITLE);
    await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), KEY_RE_SRC, { timeout: 15_000 });
    check(countKeys(await bodyText(page)) === 1, "PAID order page shows the one full license key");
    await shot(page, "a-paid");
    check((await cartItems(page)).length === 0, "the cart is cleared once the order is paid");

    await page.reload({ waitUntil: "networkidle" });
    await h1(page, PAID_TITLE);
    await page.waitForTimeout(1500); // the first status poll has answered
    const after = await bodyText(page);
    check(countKeys(after) === 0, "after a reload the key is masked");
    check(/License key/i.test(after), "the masked license is still listed");

    const pdfHref = await page.getByRole("link", { name: "Download PDF" }).getAttribute("href");
    const pdf = await page.request.get(new URL(pdfHref ?? "", BASE).href);
    const bytes = await pdf.body();
    check(pdf.status() === 200 && bytes.subarray(0, 5).toString("latin1") === "%PDF-", "invoice PDF downloads (%PDF)", pdf.status());
    check(/no-store/.test(pdf.headers()["cache-control"] ?? ""), "invoice PDF is Cache-Control: no-store");

    const row = await orderRow(orderId);
    check(row?.status === "PAID", "database: order is PAID", row?.status);
    check(row?.couponCode === "WELCOME10" && row.discountPaise > 0, "database: WELCOME10 discount recorded");
    check(row?.cgstPaise > 0 && row.sgstPaise > 0 && row.igstPaise === 0, "database: CGST + SGST, no IGST");
    check(row?.gstin === GSTIN_MH && row.accountId === null, "database: guest order with the buyer's GSTIN");
    const licenses = await orderLicenses(orderId);
    check(
      licenses.length === 1 && licenses[0].accountId === null && licenses[0].keyDeliveredAt !== null,
      "database: one guest license, key delivered once",
    );
    const invoice = await one(`SELECT number FROM "Invoice" WHERE "orderId" = $1`, [orderId]);
    check(Boolean(invoice?.number), "database: invoice number allocated");
    return s;
  } catch (error) {
    check(false, "scenario a completed", error.message);
    await shot(page, "a-error");
    await close(s, "a");
    return null;
  }
}

/** b continues in scenario a's browser (the guest who just paid), so the order page's hand-off is exercised. */
async function scenarioB(s) {
  if (!s || !state.orderId) {
    check(false, "scenario b needs scenario a (the guest order)", "run with --only=a,b");
    return;
  }
  const { page } = s;
  try {
    await page.goto(`${BASE}${state.orderPath}`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Create account" }).click();
    await page.waitForURL(/\/register\?/);
    await page.waitForFunction(() => document.querySelector("#register-email")?.value !== "", null, { timeout: 10_000 });
    check(
      (await page.locator("#register-email").inputValue()) === BUYER_EMAIL,
      "register prefills the order email (handed over in sessionStorage)",
    );
    check(!decodeURIComponent(page.url()).includes(BUYER_EMAIL), "the email is not in the URL");
    await page.locator("#register-name").fill("Rahul Verma");
    await page.locator("#register-password").fill(BUYER_PASSWORD);
    const seen = await mailIds();
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.waitForURL(/\/verify/, { timeout: 20_000 });
    const mail = await waitForMail(BUYER_EMAIL, /verification code/i, seen);
    await page.locator("#verify-code").fill(codeFrom(mail.subject));
    await page.getByRole("button", { name: "Verify email" }).click();
    await page.waitForURL((url) => url.pathname === `/orders/${state.orderId}`, { timeout: 20_000 });
    check(true, "verification continues to the order page (next)");
    state.buyer = { email: BUYER_EMAIL };

    const me = await page.evaluate(async () => (await fetch("/api/me", { cache: "no-store" })).json());
    check(me?.user?.email === BUYER_EMAIL && me.user.emailVerified === true, "/api/me: verified customer");
    check(me?.role === "OWNER" && Boolean(me.account?.id), "/api/me: owner of the new business account");
    const row = await orderRow(state.orderId);
    check(Boolean(me?.account?.id) && row?.accountId === me.account.id, "database: the guest order now belongs to the account");
    const licenses = await orderLicenses(state.orderId);
    check(licenses.length === 1 && licenses[0].accountId === me?.account?.id, "database: its license moved to the account too");
    await h1(page, PAID_TITLE);
    await shot(page, "b-claimed");
  } catch (error) {
    check(false, "scenario b completed", error.message);
    await shot(page, "b-error");
  }
}

async function scenarioC() {
  const s = await open();
  const { page } = s;
  try {
    await setCart(page, [{ planId: "med-annual", qty: 1 }]);
    await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
    await fillCheckout(page, { email: `check-${TAG}-c@example.test`, state: "Karnataka", city: "Bengaluru", pin: "560001" });
    await page.getByText("IGST 18%").first().waitFor({ timeout: 10_000 });
    const summary = await summaryText(page);
    check(/IGST 18%/.test(summary) && !/CGST/.test(summary), "inter-state (Karnataka) summary shows IGST only");
    check(await page.getByText("Inter-state supply to Karnataka: IGST.").isVisible(), "tax note names the inter-state supply");
    const status = await applyCoupon(page, "MONSOON25");
    const error = page.locator("#checkout-coupon-error");
    await error.waitFor({ timeout: 10_000 });
    const message = (await error.innerText()).trim();
    check(/^This code expired on .+\.$/.test(message), "MONSOON25 shows the expiry message", `${status} ${message}`);
    await shot(page, "c-igst-expired");
  } catch (error) {
    check(false, "scenario c completed", error.message);
    await shot(page, "c-error");
  } finally {
    await close(s, "c");
  }
}

async function scenarioD() {
  // d1: bank pending, then the simulated bank confirms.
  let s = await open();
  try {
    const start = await createOrderViaApi(s.page, { email: `check-${TAG}-d1@example.test`, state: "Karnataka", city: "Bengaluru", pin: "560001" });
    await s.page.goto(`${BASE}${start.checkout.url}`, { waitUntil: "networkidle" });
    const id = await mockOutcome(s.page, "Bank pending");
    await h1(s.page, "Payment pending with your bank");
    check((await orderRow(id))?.status === "PENDING", "pending: database status PENDING");
    await shot(s.page, "d-pending");
    await s.page.getByRole("button", { name: "confirm payment" }).click();
    await h1(s.page, PAID_TITLE);
    check((await orderRow(id))?.status === "PAID", "pending -> bank confirms -> PAID");
  } catch (error) {
    check(false, "scenario d (pending) completed", error.message);
    await shot(s.page, "d-pending-error");
  } finally {
    await close(s, "d pending");
  }

  // d2: the payment fails; "Try again" keeps the cart; the retry succeeds and only then is the cart cleared.
  s = await open();
  try {
    const { page } = s;
    await setCart(page, [{ planId: "med-annual", qty: 1 }]);
    await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
    await fillCheckout(page, { email: `check-${TAG}-d2@example.test`, state: "Maharashtra", city: "Pune", pin: "411001" });
    await pay(page);
    const id = await mockOutcome(page, "Payment fails");
    await h1(page, "Payment failed");
    check((await cartItems(page)).some((i) => i.planId === "med-annual"), "failed: the cart is kept");
    check((await orderRow(id))?.status === "FAILED", "failed: database status FAILED");
    await shot(page, "d-failed");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/dev\/mock-checkout/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const again = await mockOutcome(page, /succeeds/);
    check(again === id, "the retry pays the same order");
    await h1(page, PAID_TITLE);
    check((await orderRow(id))?.status === "PAID", "failed -> try again -> PAID");
    check((await cartItems(page)).length === 0, "the cart is cleared after the retry is paid");
  } catch (error) {
    check(false, "scenario d (failed, retry) completed", error.message);
    await shot(s.page, "d-retry-error");
  } finally {
    await close(s, "d failed+retry");
  }

  // d3: the buyer cancels on the provider page.
  s = await open();
  try {
    const start = await createOrderViaApi(s.page, { email: `check-${TAG}-d3@example.test` });
    await s.page.goto(`${BASE}${start.checkout.url}`, { waitUntil: "networkidle" });
    const id = await mockOutcome(s.page, "Cancel and return to store");
    await h1(s.page, "Payment canceled");
    check(await s.page.getByRole("button", { name: "Return to payment" }).isVisible(), "canceled: 'Return to payment' offered");
    check((await orderRow(id))?.status === "CANCELED", "cancel -> database status CANCELED");
    await shot(s.page, "d-canceled");
  } catch (error) {
    check(false, "scenario d (cancel) completed", error.message);
    await shot(s.page, "d-cancel-error");
  } finally {
    await close(s, "d cancel");
  }

  // d4: the failure is reported (by webhook) after the order page has opened: the page still picks it up.
  s = await open();
  try {
    const start = await createOrderViaApi(s.page, { email: `check-${TAG}-d4@example.test` });
    await s.page.goto(`${BASE}${start.statusUrl}`, { waitUntil: "networkidle" });
    await h1(s.page, "Waiting for payment");
    const status = await postFromPage(s.page, "/api/dev/mock-checkout", {
      orderId: start.orderId,
      t: start.orderToken,
      outcome: "failed",
      method: "UPI",
    });
    check(status === 200, "mock payment fails while the order page is open", status);
    await h1(s.page, "Payment failed", 20_000);
    check(true, "the open order page picks up the later failure (AWAITING_PAYMENT is re-checked briefly)");
  } catch (error) {
    check(false, "scenario d (late failure) completed", error.message);
    await shot(s.page, "d-late-failure-error");
  } finally {
    await close(s, "d late failure");
  }
}

/** Calls a mutating JSON API from the page with the double-submit CSRF token (as lib/client/api.ts does). */
async function postFromPage(page, url, body) {
  return page.evaluate(
    async ({ url, body }) => {
      const csrf = await (await fetch("/api/csrf", { cache: "no-store" })).json();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf.token },
        body: JSON.stringify(body),
      });
      return res.status;
    },
    { url, body },
  );
}

async function scenarioE() {
  const s = await open();
  const { page } = s;
  try {
    let email = state.buyer?.email;
    if (!email) {
      // Run on its own: register a throwaway customer first, then forget its session.
      email = `check-${TAG}-e@example.test`;
      await page.goto(`${BASE}/pricing`, { waitUntil: "domcontentloaded" });
      const status = await postFromPage(page, "/api/auth/register", { name: "Lockout Check", email, password: BUYER_PASSWORD });
      check(status === 201 || status === 200, "throwaway customer registered", status);
      await s.ctx.clearCookies();
    }
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.locator("#sign-in-email").fill(email);
    const statuses = [];
    let retryAfter = null;
    for (let i = 1; i <= 6; i++) {
      // Five wrong passwords, then the right one.
      await page.locator("#sign-in-password").fill(i === 6 ? BUYER_PASSWORD : `Wrong${i}pass${i}`);
      const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-in") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const res = await response;
      statuses.push(res.status());
      if (i === 1) {
        await page.getByText("Email or password is incorrect.", { exact: false }).first().waitFor({ timeout: 10_000 });
      }
      if (i === 6) retryAfter = Number(res.headers()["retry-after"]);
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    }
    check(statuses.slice(0, 5).every((st) => st === 401), "five wrong passwords answer 401", statuses.join(","));
    check(statuses[5] === 429 && retryAfter > 0, "the sixth attempt, with the right password, gets 429 + Retry-After", `${statuses[5]} ${retryAfter}`);
    const lock = page.getByText(/Too many attempts\. Try again in \d+ minutes?, or reset your password\./);
    await lock.first().waitFor({ timeout: 10_000 });
    check(true, "the lockout message is shown");
    check(new URL(page.url()).pathname === "/sign-in", "still on /sign-in (not signed in)");
    await shot(page, "e-lockout");
  } catch (error) {
    check(false, "scenario e completed", error.message);
    await shot(page, "e-error");
  } finally {
    await close(s, "e");
  }
}

async function scenarioF() {
  const password = ENV.SEED_DEMO_PASSWORD;
  if (!password) {
    check(false, "SEED_DEMO_PASSWORD is set in .env.local");
    return;
  }
  const s = await open();
  const { page } = s;
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
    await page.locator("#sign-in-email").fill(STAFF_EMAIL);
    await page.locator("#sign-in-password").fill(password);
    const seen = await mailIds();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Enter your sign-in code" }).waitFor({ timeout: 15_000 });
    check(true, "the staff password step asks for the emailed code");
    const mail = await waitForMail(STAFF_EMAIL, /sign-in code/i, seen);
    await page.locator("#two-step-code").fill(codeFrom(mail.subject));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/admin"), { timeout: 20_000 });
    check(true, "two-step sign-in lands on /admin");
    const me = await page.evaluate(async () => (await fetch("/api/me", { cache: "no-store" })).json());
    check(me?.user?.kind === "STAFF" && me.user.email === STAFF_EMAIL, "/api/me: signed in as the staff user");
    check(!(await s.ctx.cookies()).some((c) => c.name === "axs_td"), "no trusted-device cookie when not ticked");
    check((await postFromPage(page, "/api/auth/sign-out", {})) === 204, "staff sign-out answers 204");
  } catch (error) {
    check(false, "scenario f completed", error.message);
    await shot(page, "f-error");
  } finally {
    await close(s, "f");
  }
}

// ---------- main ----------
let exitCode = 1;
try {
  if (!ENV.DATABASE_URL) throw new Error("DATABASE_URL is missing from .env.local");
  await db.connect();
  if (opt["keep-limits"] !== "true") await resetSharedIpBuckets();
  const mailboxRes = await fetch(`${BASE}/dev/mailbox`);
  if (!mailboxRes.ok) throw new Error(`/dev/mailbox answered ${mailboxRes.status}: run a development server with EMAIL_TRANSPORT=console`);
  browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
  console.info(`Purchase journey on ${BASE} (scenarios ${[...ONLY].join(", ")}; buyer check-${TAG}@example.test)`);

  let guest = null;
  if (ONLY.has("a")) {
    current = "a";
    guest = await scenarioA();
  }
  if (ONLY.has("b")) {
    current = "b";
    await scenarioB(guest);
  }
  if (guest) {
    current = ONLY.has("b") ? "b" : "a";
    await close(guest, ONLY.has("b") ? "a+b" : "a");
  }
  const rest = [
    ["c", scenarioC],
    ["d", scenarioD],
    ["e", scenarioE],
    ["f", scenarioF],
  ];
  for (const [key, run] of rest) {
    if (!ONLY.has(key)) continue;
    current = key;
    await run();
  }
  const failed = results.filter((r) => !r.ok);
  console.info(`\n${results.length} checks, ${failed.length} failure${failed.length === 1 ? "" : "s"}.`);
  for (const f of failed) console.info(`  FAIL [${f.scenario}] ${f.label}${f.detail !== undefined ? ` -> ${f.detail}` : ""}`);
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(`check-purchase could not run: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close().catch(() => {});
  await db.end().catch(() => {});
}
process.exit(exitCode);
