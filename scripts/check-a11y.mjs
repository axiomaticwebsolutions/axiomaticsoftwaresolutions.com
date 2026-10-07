/**
 * Accessibility check of states the page crawls never reach (dev tool; docs/accessibility.md). Drives the installed
 * Google Chrome through Playwright against a dev server with PAYMENT_PROVIDER=mock, EMAIL_TRANSPORT=console and the seed.
 *
 *   node scripts/check-a11y.mjs [--base=http://localhost:3000]
 *     [--only=focus,store,auth,orders,portal,admin,reflow,motion,forced] [--verbose]
 *
 *   focus    Keyboard-only Tab walks through key pages (storefront, auth, portal, admin at 1280px; storefront and portal
 *            at 360px): the skip link comes first and moves focus into <main>; every stop has a visible focus
 *            indicator (outline or box-shadow), is not covered by a sticky header, tray or overlay (WCAG 2.4.7, 2.4.11)
 *            and is never hidden or off screen.
 *   store    Widgets: Software menu (arrows, Escape returns focus), mobile menu and catalog filters drawers at 360px
 *            (focus moves in, Tab is trapped, Escape closes and focus returns), product tabs, the add-to-cart toast
 *            (polite live region; Alt+T reaches it and pauses its timer), the cart, and the checkout error summary
 *            (focused; fields carry aria-invalid and a described message). axe runs in each open state.
 *   auth     Sign-in, register and forgot-password error states (summary focus, aria-invalid/aria-describedby), a
 *            refused password (alert banner, focus kept), and the two-step code step (focus on the labelled numeric
 *            one-time-code field) for a staff sign-in that is never completed.
 *   orders   The order page in every state the data has (paid, awaiting payment, confirming, pending, failed,
 *            canceled, refunded) through a signed guest link (orders whose keys were already delivered only) or as
 *            the account Owner, at 1280 and 360px: one h1, the hero in a polite live region, no overflow, axe.
 *   portal   As the demo Owner: global search combobox (Ctrl+K, arrows, aria-activedescendant, Escape), bell, help
 *            and business menus, license tabs, the key reveal dialog, a row select that acts on change (arrows only
 *            browse, Escape changes nothing), a sortable header, row selection and the bulk bar, the 360px sidebar
 *            drawer. axe in each open state.
 *   admin    As the demo Administrator: module search, opening a row's drawer from the keyboard (focus moves in and
 *            returns to the row), a destructive dialog inside it (reason required, Escape returns focus to its
 *            button), the 360px sidebar drawer.
 *   reflow   WCAG 1.4.10 / 1.4.4 / 1.4.12 on key pages: 320 CSS px (= 1280px at 400%), 640px (= 200% zoom), and
 *            text spacing (line height 1.5, letter 0.12em, word 0.16em, paragraph 2em) at 360 and 1280px without a
 *            horizontal page scroll or clipped text.
 *   motion   prefers-reduced-motion: reduce: no CSS animation or transition longer than 1ms, smooth scrolling off.
 *   forced   Forced colours (Windows contrast themes): focused text fields keep an outline, solid buttons a border,
 *            pressed / selected / current / highlighted items use the system Highlight, the switch stays visible.
 *
 * Signs seeded people in over HTTP (two-step code from /dev/mailbox) and hands only the session cookie to the
 * browser; signs them out at the end. Creates no data except sign-in records (sessions, sign-in code emails) and
 * read-only page views. Never prints passwords, codes, keys or tokens. Exit code 1 when any check fails.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import pg from "pg";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const BASE = new URL(opt.base ?? process.env.A11Y_BASE_URL ?? "http://localhost:3000").origin;
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = new Set(list(opt.only ?? "focus,store,auth,orders,portal,admin,reflow,motion,forced"));
const VERBOSE = opt.verbose === "true";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];

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
const PEOPLE = {
  owner: { email: "priya@sharmamedicals.example", password: ENV.SEED_DEMO_PASSWORD ?? "", label: "Priya (Owner)" },
  admin: { email: "vikram@axiomatic.example", password: ENV.SEED_DEMO_PASSWORD ?? "", label: "Vikram (Administrator)" },
  staffOwner: { email: ENV.SEED_OWNER_EMAIL ?? "", password: ENV.SEED_OWNER_PASSWORD ?? "", label: "the seeded staff Owner" },
};

const results = [];
let current = "setup";
/** Masks credentials that can appear in URLs inside error messages (order link tokens, signed URLs). */
const redact = (text) => String(text).replace(/([?&](?:t|token|sig|signature|exp|X-Amz-[A-Za-z]+)=)[^&\s"'`]+/g, "$1…");
function check(ok, label, detail) {
  const shown = ok || detail === undefined ? undefined : redact(detail).slice(0, 700);
  results.push({ scenario: current, ok: Boolean(ok), label, detail: shown });
  if (!ok || VERBOSE) console.info(`${ok ? "PASS" : "FAIL"} [${current}] ${label}${shown !== undefined ? ` -> ${shown}` : ""}`);
  return Boolean(ok);
}
const note = (message) => console.info(`note [${current}] ${redact(message)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- HTTP sign-in (seeded passwords and codes never reach the browser, traces or output) ----------
class Http {
  jar = new Map();
  async fetch(pathname, init = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(BASE + pathname, { ...init, headers, redirect: "manual", cache: "no-store" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  async api(method, pathname, body) {
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      const csrf = await (await this.fetch("/api/csrf")).json();
      headers["x-csrf-token"] = csrf.token;
      headers.origin = BASE;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const res = await this.fetch(pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }
  cookies() {
    return [...this.jar].map(([name, value]) => ({ name, value, url: BASE }));
  }
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** Messages in /dev/mailbox, newest first: { id, subject, to }. */
async function mailbox() {
  const html = await (await fetch(`${BASE}/dev/mailbox`, { cache: "no-store" })).text();
  const re = /href="\/dev\/mailbox\?id=([^"]+)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => ({ id: decode(m[1]), subject: decode(m[2]), to: decode(m[3]) }));
}

async function waitForMail(to, subjectRe, exclude, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await mailbox()).find((m) => m.to === to && subjectRe.test(m.subject) && !exclude.has(m.id));
    if (hit) return hit;
    await sleep(400);
  }
  throw new Error(`no email to ${to} matching ${subjectRe}`);
}

const sessions = [];

/** Signs a seeded person in over HTTP (two-step code from /dev/mailbox when asked). */
async function signIn(person) {
  const http = new Http();
  const before = new Set((await mailbox()).map((m) => m.id));
  const res = await http.api("POST", "/api/auth/sign-in", { email: person.email, password: person.password });
  if (res.status !== 200) throw new Error(`sign-in of ${person.email} answered ${res.status} ${res.body?.error?.code ?? ""}`);
  if (res.body?.requires2fa) {
    for (let attempt = 1; ; attempt++) {
      const mail = await waitForMail(person.email, /sign-in code/i, before, attempt === 1 ? 45_000 : 15_000);
      before.add(mail.id);
      const code = /(\d{6})/.exec(mail.subject)?.[1];
      const verified = await http.api("POST", "/api/auth/sign-in/verify", { challengeId: res.body.challengeId, code, trustDevice: false });
      if (verified.status === 200) break;
      if (verified.status !== 422 || attempt >= 3) throw new Error(`two-step code of ${person.email} answered ${verified.status}`);
    }
  }
  if (!http.jar.has("axs_session")) throw new Error(`sign-in of ${person.email} set no session cookie`);
  sessions.push(http);
  return http;
}

async function signOutAll() {
  for (const http of sessions) await http.api("POST", "/api/auth/sign-out", {}).catch(() => undefined);
}

// ---------- browser ----------
let browser;

async function open({ width = 1280, height = 900, http = null, reducedMotion = "reduce" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  if (http) await ctx.addCookies(http.cookies());
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 200)}`));
  return { ctx, page, problems };
}

async function close(s, label) {
  check(s.problems.length === 0, `${label}: no page errors`, s.problems.join(" | "));
  await s.ctx.close();
}

async function go(page, pathname) {
  const res = await page.goto(BASE + pathname, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  return res;
}

/** Waits until React has hydrated the element (its DOM node carries a React fiber). */
async function hydrated(page, selector = "main") {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
    },
    selector,
    { timeout: 60_000 },
  );
}

/** axe-core WCAG 2.0 A/AA + 2.1 AA on the page as it is now (after running animations settle). */
async function axe(page, label, { skip = [] } = {}) {
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5_000 })
    .catch(() => undefined);
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(skip).analyze();
  const violations = result.violations.map(
    (v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help} -> ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`,
  );
  check(violations.length === 0, `${label}: no axe violations`, violations.join(" || "));
}

/** Facts about the focused element: name, visible focus indicator, obscured, hidden. Runs in the page. */
function focusFacts() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { none: true };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? "";
  const name = (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("placeholder") ?? el.id ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  const id = el.id ? `#${el.id}` : "";
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && !/rgba\(\d+, \d+, \d+, 0\)/.test(cs.outlineColor);
  const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
  // A child that draws the indicator (e.g. a styled span inside a label) or :focus-within styling of the parent.
  const within = el.parentElement ? getComputedStyle(el.parentElement) : null;
  const parentShadow = !!within && within.boxShadow !== "none" && el.parentElement.matches(":focus-within");
  const parentOutline = !!within && within.outlineStyle !== "none" && parseFloat(within.outlineWidth) > 0 && el.parentElement.matches(":focus-within");
  const visibleIndicator = outline || shadow || parentShadow || parentOutline;
  const sizeOk = r.width > 0 && r.height > 0;
  let hidden = !sizeOk || cs.visibility === "hidden" || el.closest("[hidden],[aria-hidden='true'],[inert]") !== null;
  // Off-screen (skip links before focus excepted: they move on screen when focused).
  const offscreen = r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight;
  // Obscured: the element's centre (or any corner inset by 2px) is covered by something that is not the element.
  let obscured = false;
  if (!hidden && !offscreen) {
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.bottom - 2],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    const covered = points.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el.labels && [...el.labels].some((l) => l.contains(hit)));
    });
    obscured = points.length > 0 && covered.length === points.length;
    if (obscured) {
      const hit = document.elementFromPoint(points[0][0], points[0][1]);
      hidden = false;
      return { tag, role, name, id, visibleIndicator, hidden, offscreen, obscured, by: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}.${String(hit.className).slice(0, 60)}` : "" };
    }
  }
  return { tag, role, name, id, visibleIndicator, hidden, offscreen, obscured };
}

const describe = (f) => `${f.tag}${f.role ? `[role=${f.role}]` : ""}${f.id} "${f.name}"`;

/**
 * Presses Tab from the top of the page up to `max` times (or until focus comes back to an element already visited) and
 * checks every stop: visible indicator, not hidden, not off screen, not obscured. Returns the stops.
 */
async function tabWalk(page, label, { max = 70, start = "body" } = {}) {
  if (start === "body") {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
  }
  const stops = [];
  const bad = { indicator: [], hidden: [], offscreen: [], obscured: [] };
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    await sleep(120);
    const seen = await page.evaluate((index) => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      // The Next.js development overlay (dev builds only) sits after the page.
      if (el.tagName.toLowerCase() === "nextjs-portal") return "devtools";
      if (el.hasAttribute("data-a11y-tab")) return "repeat";
      el.setAttribute("data-a11y-tab", String(index));
      return "new";
    }, i);
    if (seen !== "new") break;
    const f = await page.evaluate(focusFacts);
    if (f.none) break;
    stops.push(f);
    if (!f.visibleIndicator && !f.hidden) bad.indicator.push(describe(f));
    if (f.hidden) bad.hidden.push(describe(f));
    else if (f.offscreen) bad.offscreen.push(describe(f));
    else if (f.obscured) bad.obscured.push(`${describe(f)} under ${f.by}`);
  }
  await page.evaluate(() => document.querySelectorAll("[data-a11y-tab]").forEach((el) => el.removeAttribute("data-a11y-tab")));
  check(bad.indicator.length === 0, `${label}: every Tab stop shows a focus indicator (${stops.length} stops)`, bad.indicator.join(", "));
  check(bad.hidden.length === 0, `${label}: Tab never lands on a hidden element`, bad.hidden.join(", "));
  check(bad.offscreen.length === 0, `${label}: Tab never lands off screen`, bad.offscreen.join(", "));
  check(bad.obscured.length === 0, `${label}: focused elements are not covered (sticky header, tray, overlay)`, bad.obscured.join(", "));
  if (VERBOSE) note(`${label}: ${stops.map(describe).join(" > ")}`);
  return stops;
}

/** Describes the focused element (for focus-return checks). */
async function focused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${name}"`;
  });
}

/** True when focus is inside the element matched by `selector`. */
async function focusInside(page, selector) {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    return !!box && box.contains(document.activeElement);
  }, selector);
}

/** Presses Tab `n` times and reports whether focus stayed inside `selector` the whole time (a modal focus trap). */
async function trapped(page, selector, n = 25) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    if (!(await focusInside(page, selector))) return false;
  }
  return true;
}

// ---------- database (read-only lookups) ----------
const db = new pg.Client({ connectionString: (ENV.DATABASE_URL ?? "").replace(/\?.*$/, "") });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] ?? null;

// ---------- focus: keyboard-only Tab walks ----------
async function skipLinkCheck(page, label) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("Tab");
  // Headless Chrome can report the pre-focus style for a moment after the key press.
  await sleep(150);
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el?.getBoundingClientRect();
    return { text: el?.textContent?.trim() ?? "", href: el?.getAttribute("href") ?? "", onScreen: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth };
  });
  check(first.text === "Skip to content" && first.onScreen, `${label}: the first Tab stop is a visible "Skip to content"`, JSON.stringify(first));
  await page.keyboard.press("Enter");
  await sleep(150);
  const target = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() + (document.activeElement?.id ? `#${document.activeElement.id}` : ""));
  check(target === "main#main", `${label}: the skip link moves focus to <main>`, target);
}

async function scenarioFocus(ctxs) {
  current = "focus";
  const s = await open({ width: 1280 });
  const pages = ["/", "/software", "/software/medical-billing", "/pricing", "/contact", "/support", "/cart", "/sign-in", "/register"];
  for (const p of pages) {
    await go(s.page, p);
    await hydrated(s.page);
    if (!["/sign-in", "/register"].includes(p)) await skipLinkCheck(s.page, p);
    await tabWalk(s.page, p, { max: p === "/" || p.startsWith("/software") ? 90 : 60 });
  }
  await close(s, "focus storefront");

  // Phones: the sticky header and the product page's sticky in-page nav must not cover the focused element.
  const p360 = await open({ width: 360, height: 740 });
  for (const p of ["/", "/software", "/software/medical-billing", "/pricing", "/cart"]) {
    await go(p360.page, p);
    await hydrated(p360.page);
    await tabWalk(p360.page, `${p} @360`, { max: 60 });
  }
  await close(p360, "focus storefront 360");

  if (ctxs.owner) {
    const o = await open({ width: 1280, http: ctxs.owner });
    for (const p of ["/account", "/account/licenses", `/account/licenses/${ctxs.license}`, "/account/devices", "/account/tickets/new", "/account/security"]) {
      await go(o.page, p);
      await hydrated(o.page);
      await skipLinkCheck(o.page, p);
      await tabWalk(o.page, p, { max: 70 });
    }
    await close(o, "focus portal");
    const o360 = await open({ width: 360, height: 740, http: ctxs.owner });
    for (const p of ["/account/licenses", "/account/devices"]) {
      await go(o360.page, p);
      await hydrated(o360.page);
      await tabWalk(o360.page, `${p} @360`, { max: 50 });
    }
    await close(o360, "focus portal 360");
  }
  if (ctxs.admin) {
    const a = await open({ width: 1280, http: ctxs.admin });
    for (const p of ["/admin", "/admin/orders", "/admin/products", "/admin/settings"]) {
      await go(a.page, p);
      await hydrated(a.page);
      await skipLinkCheck(a.page, p);
      await tabWalk(a.page, p, { max: 70 });
    }
    await close(a, "focus admin");
  }
}

// ---------- store: storefront widgets ----------
/** Opens a modal (Radix dialog) from `trigger` with Enter and checks focus in, trap, axe, Escape and focus return. */
async function modalCheck(page, label, trigger, { axeLabel = label, afterOpen } = {}) {
  await trigger.focus();
  const opener = await focused(page);
  await page.keyboard.press("Enter");
  const dialog = page.locator("[role='dialog'], [role='alertdialog']").last();
  const opened = await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!check(opened, `${label}: Enter opens it`)) return false;
  await sleep(300);
  check(await focusInside(page, "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"), `${label}: focus moves into it`, await focused(page));
  const name = await dialog.evaluate((el) => {
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    return el.getAttribute("aria-label") ?? ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  });
  check(name.length > 0, `${label}: the dialog has an accessible name`, name);
  check((await dialog.getAttribute("aria-modal")) === "true" || (await page.evaluate(() => !!document.querySelector("[data-radix-focus-guard]"))), `${label}: modal (aria-modal or focus guards)`);
  if (afterOpen) await afterOpen();
  await axe(page, `${axeLabel} (open)`);
  check(await trapped(page, "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"), `${label}: Tab and Shift+Tab stay inside`, await focused(page));
  await page.keyboard.press("Escape");
  const closed = await dialog.waitFor({ state: "detached", timeout: 10_000 }).then(() => true, () => false);
  check(closed, `${label}: Escape closes it`);
  await sleep(250);
  const back = await focused(page);
  check(back === opener, `${label}: focus returns to the opener`, `${back} (opener ${opener})`);
  return true;
}

async function scenarioStore() {
  // Software menu (1280).
  const s = await open({ width: 1280 });
  const { page } = s;
  await go(page, "/pricing");
  await hydrated(page, "#site-header");
  const trigger = page.locator("header button[aria-controls]", { hasText: "Software" }).first();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await sleep(250);
  check((await trigger.getAttribute("aria-expanded")) === "true", "Software menu: ArrowDown opens it (aria-expanded=true)");
  const inMenu = await page.evaluate(() => {
    const t = [...document.querySelectorAll("header button[aria-controls]")].find((b) => b.textContent?.includes("Software"));
    const menu = t && document.getElementById(t.getAttribute("aria-controls") ?? "");
    return !!menu && menu.contains(document.activeElement);
  });
  check(inMenu, "Software menu: focus moves to the first link", await focused(page));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await axe(page, "Software menu (open)");
  await page.keyboard.press("Escape");
  await sleep(200);
  check((await trigger.getAttribute("aria-expanded")) === "false", "Software menu: Escape closes it");
  check((await focused(page)).includes("Software"), "Software menu: Escape returns focus to the trigger", await focused(page));

  // Product page: screenshot tabs (arrow keys) and the add-to-cart toast.
  await go(page, "/software/medical-billing");
  await hydrated(page);
  const tab = page.locator("[role='tablist'] [role='tab']").first();
  if ((await tab.count()) > 0) {
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await sleep(150);
    const sel = await page.evaluate(() => {
      const el = document.activeElement;
      return { role: el?.getAttribute("role"), selected: el?.getAttribute("aria-selected"), controls: !!document.getElementById(el?.getAttribute("aria-controls") ?? "") };
    });
    check(sel.role === "tab" && sel.selected === "true" && sel.controls, "product tabs: ArrowRight selects the next tab, which controls its panel", JSON.stringify(sel));
  }
  const add = page.getByRole("button", { name: /add to cart/i }).first();
  await add.focus();
  await page.keyboard.press("Enter");
  const toast = page.locator("[data-sonner-toast]").first();
  const shown = await toast.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check(shown, "add to cart: the toast appears");
  const live = await page.evaluate(() => {
    const t = document.querySelector("[data-sonner-toast]");
    const region = t?.closest("[aria-live]");
    return region ? `${region.getAttribute("aria-live")}|${region.getAttribute("aria-label")}` : null;
  });
  check(!!live && live.startsWith("polite"), "add to cart: the toast is inside a polite live region", live);
  check((await focused(page)).toLowerCase().includes("add to cart"), "add to cart: focus stays on the button", await focused(page));
  await axe(page, "product page with the cart toast");
  // Alt+T reaches the toast; its actions are reachable with Tab.
  await page.keyboard.press("Alt+T");
  await sleep(200);
  await page.keyboard.press("Tab");
  check(await page.evaluate(() => !!document.activeElement?.closest("[data-sonner-toaster]")), "toast: Alt+T then Tab reaches it", await focused(page));
  await sleep(7_000);
  check((await page.locator("[data-sonner-toast]").count()) > 0, "toast: it stays while the keyboard is in it (timer paused by Alt+T)");
  await page.keyboard.press("Escape");

  // A per-terminal plan, so the cart has a quantity stepper.
  await go(page, "/software/restaurant-billing");
  await hydrated(page);
  const perTerminal = page.getByRole("button", { name: /add to cart/i }).first();
  if ((await perTerminal.count()) > 0) {
    await perTerminal.focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  }

  // Cart: quantity stepper (when a line has one) and remove.
  await go(page, "/cart");
  await hydrated(page);
  const stepper = page.locator("[data-slot=quantity-stepper]").first();
  if ((await stepper.count()) > 0) {
    const inc = stepper.locator("button").last();
    await inc.focus();
    const before = (await stepper.innerText()).trim();
    await page.keyboard.press("ArrowUp");
    await sleep(200);
    const after = (await stepper.innerText()).trim();
    check(before !== after || (await inc.getAttribute("aria-disabled")) === "true", "cart: ArrowUp on the stepper changes the quantity (or it is at its maximum)", `${before} -> ${after}`);
    check((await stepper.getAttribute("aria-label")) || (await stepper.getAttribute("aria-labelledby")), "cart: the stepper group is labelled");
  } else {
    current = "store";
    console.info("note [store] cart line has no quantity stepper (fixed quantity plan)");
  }
  await axe(page, "cart with lines");

  // Checkout: submitting the empty form focuses the error summary; fields carry aria-invalid and a described error.
  await go(page, "/checkout");
  await hydrated(page);
  const submit = page.locator("main form button[type=submit]").last();
  await submit.waitFor({ timeout: 30_000 });
  await submit.focus();
  await page.keyboard.press("Enter");
  await sleep(400);
  const summary = await page.evaluate(() => {
    const el = document.activeElement;
    return { role: el?.getAttribute("role"), text: el?.textContent?.trim().slice(0, 80) };
  });
  check(summary.role === "alert", "checkout: an empty submit moves focus to the error summary (role=alert)", JSON.stringify(summary));
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll("main form [aria-invalid=true]")].map((el) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const described = ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
      const label = el.labels?.[0]?.textContent?.trim() ?? el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? "";
      return { id: el.id, label, described };
    }),
  );
  check(fields.length > 0, "checkout: invalid fields are marked aria-invalid", fields.length);
  const unexplained = fields.filter((f) => !f.described || !f.label);
  check(unexplained.length === 0, "checkout: every invalid field has a label and a described error message", JSON.stringify(unexplained));
  await axe(page, "checkout with errors");
  await close(s, "store 1280");

  // 360px: mobile menu and catalog filters drawers.
  const m = await open({ width: 360, height: 780 });
  await go(m.page, "/");
  await hydrated(m.page, "#site-header");
  await modalCheck(m.page, "mobile menu (360)", m.page.getByRole("button", { name: "Menu", exact: true }));
  await go(m.page, "/software");
  await hydrated(m.page);
  await modalCheck(m.page, "catalog filters drawer (360)", m.page.getByRole("button", { name: /^Filters/ }));
  await close(m, "store 360");
}

// ---------- auth: error states and the two-step step ----------
/** Facts about every control marked aria-invalid inside `scope`: label and described error text. */
async function invalidFields(page, scope = "main") {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(`${sel} [aria-invalid=true]`)].map((el) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      const described = ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
      const labelled = (el.getAttribute("aria-labelledby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const label = (el.labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? labelled).trim();
      return { id: el.id, label, described };
    }), scope);
}

async function emptySubmit(page, label, path, submitName) {
  await go(page, path);
  await hydrated(page, "main form");
  const submit = page.locator("main form").getByRole("button", { name: submitName, exact: true });
  await submit.focus();
  await page.keyboard.press("Enter");
  await sleep(400);
  const active = await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), id: document.activeElement?.id ?? "" }));
  check(active.role === "alert", `${label}: an empty submit moves focus to the error summary`, JSON.stringify(active));
  const fields = await invalidFields(page);
  check(fields.length > 0 && fields.every((f) => f.label && f.described), `${label}: invalid fields have a label and a described error`, JSON.stringify(fields));
  // The summary links focus their field.
  const link = page.locator("[data-slot=form-error-summary] a, [role=alert] a[href^='#']").first();
  if ((await link.count()) > 0) {
    await link.focus();
    await page.keyboard.press("Enter");
    await sleep(200);
    const target = (await link.getAttribute("href"))?.slice(1);
    check((await page.evaluate(() => document.activeElement?.id)) === target, `${label}: a summary link focuses its field`, await focused(page));
  }
  await axe(page, `${label} with errors`);
}

async function scenarioAuth() {
  const s = await open({ width: 1280 });
  const { page } = s;
  await emptySubmit(page, "sign-in", "/sign-in", "Sign in");
  await emptySubmit(page, "register", "/register", "Create account");
  await emptySubmit(page, "forgot password", "/forgot", "Send reset link");

  // Wrong password for an address that has no account: the banner is an alert and focus stays on the submit button.
  await go(page, "/sign-in");
  await hydrated(page, "#sign-in-email");
  await page.locator("#sign-in-email").fill(`a11y-nobody-${Date.now().toString(36)}@example.test`);
  await page.locator("#sign-in-password").fill("not-the-password-1");
  const submit = page.locator("main form").getByRole("button", { name: "Sign in", exact: true });
  await submit.focus();
  await page.keyboard.press("Enter");
  const banner = page.locator("main [role=alert]").first();
  const shown = await banner.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check(shown, "sign-in: a refused password shows an alert banner");
  check((await focused(page)).includes("Sign in"), "sign-in: focus stays on the submit button after a refusal", await focused(page));
  await axe(page, "sign-in with a refusal banner");

  // Two-step step (seeded staff Owner, never completed): focus lands on the labelled one-time-code field.
  if (PEOPLE.staffOwner.email && PEOPLE.staffOwner.password) {
    await go(page, "/sign-in");
    await hydrated(page, "#sign-in-email");
    await page.locator("#sign-in-email").fill(PEOPLE.staffOwner.email);
    await page.locator("#sign-in-password").fill(PEOPLE.staffOwner.password);
    await page.locator("main form").getByRole("button", { name: "Sign in", exact: true }).click();
    const code = page.locator("input[autocomplete='one-time-code']");
    const reached = await code.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (check(reached, "two-step: the code step appears")) {
      await sleep(300);
      const facts = await code.evaluate((el) => ({
        focused: document.activeElement === el,
        label: el.labels?.[0]?.textContent?.trim() ?? "",
        inputMode: el.getAttribute("inputmode"),
        described: (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim(),
        h1: document.querySelector("h1")?.textContent ?? "",
      }));
      check(facts.focused, "two-step: focus moves to the code field", await focused(page));
      check(facts.label.length > 0 && facts.inputMode === "numeric", "two-step: the code field is labelled and numeric", JSON.stringify({ label: facts.label, inputMode: facts.inputMode }));
      check(facts.described.length > 0, "two-step: the code field is described by the sent-to sentence", facts.described.replace(/\S+@\S+/g, "<email>"));
      // An incomplete code: the error summary and the field error.
      await code.fill("12");
      await page.keyboard.press("Enter");
      await sleep(400);
      const fields = await invalidFields(page);
      check(fields.length === 1 && fields[0].described, "two-step: a short code marks the field invalid with a described error", JSON.stringify(fields));
      await axe(page, "two-step step with an error");
    }
  }
  await close(s, "auth");
}

// ---------- orders: the order page in each state ----------
/** A guest order link token (lib/orders/token.ts format), signed with ORDER_TOKEN_SECRET; never printed. */
function orderToken(orderId, email) {
  const secret = ENV.ORDER_TOKEN_SECRET ?? "";
  const mac = (data) => createHmac("sha256", secret).update(data, "utf8").digest("base64url");
  const expPart = Math.floor((Date.now() + 600_000) / 1000).toString(36);
  const emailTag = mac(`order-email:${email.trim().toLowerCase()}`).slice(0, 16);
  return `o1.${expPart}.${emailTag}.${mac(`order-link:o1:${orderId}:${emailTag}:${expPart}`)}`;
}

async function scenarioOrders(ctxs) {
  // Guest orders in every status; PAID only when every key was already delivered (a visit never delivers one).
  const rows = (
    await db.query(
      `SELECT DISTINCT ON (o.status) o.id, o.status, o.email FROM "Order" o
        WHERE o."accountId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "License" l WHERE l."orderId" = o.id AND l."keyDeliveredAt" IS NULL)
        ORDER BY o.status, o."createdAt" DESC`,
    )
  ).rows;
  const s = await open({ width: 1280 });
  const m = await open({ width: 360, height: 780 });
  for (const row of rows) {
    const url = `/orders/${encodeURIComponent(row.id)}?t=${orderToken(row.id, row.email)}`;
    for (const ctx of [s, m]) {
      const width = ctx === s ? 1280 : 360;
      const label = `order ${row.status} @${width}`;
      await go(ctx.page, url);
      await hydrated(ctx.page);
      await sleep(500);
      const facts = await ctx.page.evaluate(() => ({
        h1: document.querySelectorAll("h1").length,
        status: !!document.querySelector("h1")?.closest("[role=status][aria-live]"),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        title: document.title,
      }));
      check(facts.h1 === 1, `${label}: one h1`, facts.h1);
      check(facts.status, `${label}: the hero heading sits in a polite live region`);
      check(width > 400 || facts.overflow <= 0, `${label}: no horizontal overflow`, facts.overflow);
      await axe(ctx.page, label);
    }
  }
  await close(s, "orders 1280");
  await close(m, "orders 360");

  // Account orders (PAID, CANCELED, REFUNDED) as the Owner.
  if (ctxs.owner) {
    const own = (
      await db.query(
        `SELECT DISTINCT ON (o.status) o.id, o.status FROM "Order" o JOIN "AccountMember" m ON m."accountId" = o."accountId"
           JOIN "User" u ON u.id = m."userId" WHERE u.email = $1 ORDER BY o.status, o."createdAt"`,
        [PEOPLE.owner.email],
      )
    ).rows;
    const o = await open({ width: 1280, http: ctxs.owner });
    for (const row of own) {
      await go(o.page, `/orders/${encodeURIComponent(row.id)}`);
      await hydrated(o.page);
      await axe(o.page, `account order ${row.status} @1280`);
    }
    await close(o, "account orders");
  }
}

// ---------- portal: customer portal widgets ----------
/** Opens a menu or popover with Enter on `trigger`, checks focus moves in, axe, Escape returns focus. */
async function popupCheck(page, label, trigger, popupSelector) {
  await trigger.focus();
  const opener = await focused(page);
  await page.keyboard.press("Enter");
  const popup = page.locator(popupSelector).last();
  if (!check(await popup.waitFor({ timeout: 10_000 }).then(() => true, () => false), `${label}: Enter opens it`)) return;
  await sleep(400);
  check(await page.evaluate((sel) => [...document.querySelectorAll(sel)].some((p) => p.contains(document.activeElement)), popupSelector), `${label}: focus moves into it`, await focused(page));
  check((await trigger.getAttribute("aria-expanded")) === "true", `${label}: the trigger says aria-expanded=true`);
  await page.keyboard.press("ArrowDown");
  await axe(page, `${label} (open)`);
  await page.keyboard.press("Escape");
  await sleep(300);
  check((await focused(page)) === opener, `${label}: Escape closes it and focus returns to the trigger`, `${await focused(page)} (opener ${opener})`);
}

async function scenarioPortal(ctxs) {
  if (!ctxs.owner) return;
  const s = await open({ width: 1280, http: ctxs.owner });
  const { page } = s;
  await go(page, "/account");
  await hydrated(page);

  // Global search combobox.
  await page.keyboard.press("Control+K");
  await sleep(200);
  const combo = page.locator("input[role=combobox]").first();
  check(await combo.evaluate((el) => el === document.activeElement), "global search: Ctrl+K focuses the combobox", await focused(page));
  await combo.pressSequentially("LIC", { delay: 40 });
  const option = page.locator("[role=listbox] [role=option]").first();
  if (check(await option.waitFor({ timeout: 20_000 }).then(() => true, () => false), "global search: typing shows options")) {
    await page.keyboard.press("ArrowDown");
    await sleep(150);
    const facts = await combo.evaluate((el) => {
      const id = el.getAttribute("aria-activedescendant");
      const opt = id ? document.getElementById(id) : null;
      return { expanded: el.getAttribute("aria-expanded"), active: !!opt, selected: opt?.getAttribute("aria-selected"), status: document.querySelector("[role=status][aria-live]")?.textContent ?? "" };
    });
    check(facts.expanded === "true" && facts.active && facts.selected === "true", "global search: ArrowDown moves aria-activedescendant to a selected option", JSON.stringify(facts));
    await axe(page, "global search (open)");
    await page.keyboard.press("Escape");
    await sleep(150);
    check((await combo.getAttribute("aria-expanded")) === "false" && (await combo.evaluate((el) => el === document.activeElement)), "global search: Escape closes the results and keeps focus");
    await page.keyboard.press("Escape");
  }

  // Bell, help and (when shown) the account menu.
  await popupCheck(page, "notifications popover", page.locator("header button[aria-label^='Notifications']").first(), "[data-radix-popper-content-wrapper] [role=dialog]");
  await popupCheck(page, "help menu", page.locator("header button[aria-label='Help']").first(), "[role=menu]");
  await popupCheck(page, "business switcher", page.locator("aside button[aria-haspopup=dialog]").first(), "[data-radix-popper-content-wrapper] [role=dialog]");

  // License detail: tabs and the key reveal dialog.
  await go(page, `/account/licenses/${ctxs.license}`);
  await hydrated(page);
  const tabs = page.locator("[role=tablist] [role=tab]");
  if ((await tabs.count()) > 1) {
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await sleep(300);
    const t = await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), selected: document.activeElement?.getAttribute("aria-selected"), url: location.search }));
    check(t.role === "tab" && t.selected === "true", "license tabs: ArrowRight selects the next tab", JSON.stringify(t));
    await page.keyboard.press("ArrowLeft");
    await sleep(300);
  }
  const reveal = page.getByRole("button", { name: "Reveal", exact: true }).first();
  if ((await reveal.count()) > 0) await modalCheck(page, "key reveal dialog", reveal);

  // Devices: row selection with the keyboard and the bulk bar.
  await go(page, "/account/devices");
  await hydrated(page);
  // Row location select (acts on change): arrows only browse, Escape leaves the value unchanged (WCAG 3.2.2).
  const rowSelect = page.locator("table button[role=combobox][aria-label^='Location for ']").first();
  if ((await rowSelect.count()) > 0) {
    const before = (await rowSelect.innerText()).trim();
    await rowSelect.focus();
    await page.keyboard.press("ArrowDown");
    const list = page.locator("[role=listbox][data-state=open]").first();
    check(await list.waitFor({ timeout: 10_000 }).then(() => true, () => false), "row select: ArrowDown opens the listbox");
    await sleep(250);
    await page.keyboard.press("ArrowDown");
    // Radix Select is modal: while open it hides the rest of the page with aria-hidden and traps focus, so nothing
    // hidden can be focused. axe only knows dialogs as modals and reports aria-hidden-focus here (false positive).
    await axe(page, "row select (open)", { skip: ["aria-hidden-focus"] });
    await page.keyboard.press("Escape");
    await sleep(300);
    check((await rowSelect.innerText()).trim() === before, "row select: browsing and Escape change nothing", `${before} -> ${(await rowSelect.innerText()).trim()}`);
    check(await rowSelect.evaluate((el) => el === document.activeElement), "row select: Escape returns focus to the trigger", await focused(page));
  }
  // Sortable column header (Orders): Enter sorts, aria-sort moves to that column, focus stays on the header button.
  await go(page, "/account/orders");
  await hydrated(page);
  const sortButton = page.locator("table thead th button:not([role=checkbox])").first();
  if ((await sortButton.count()) > 0) {
    await sortButton.focus();
    await page.keyboard.press("Enter");
    await sleep(600);
    const th = await sortButton.evaluate((el) => ({ sort: el.closest("th")?.getAttribute("aria-sort"), focused: el === document.activeElement || el.closest("th")?.contains(document.activeElement) }));
    check(th.sort === "ascending" || th.sort === "descending", "sortable header: Enter sets aria-sort on its column", JSON.stringify(th));
    check(th.focused, "sortable header: focus stays on the header button", await focused(page));
    await page.keyboard.press("Enter");
    await sleep(400);
  }
  await go(page, "/account/devices");
  await hydrated(page);
  const rowBox = page.locator("table [role=checkbox][aria-label^='Select ']:not([aria-label^='Select all'])").first();
  if ((await rowBox.count()) > 0) {
    await rowBox.focus();
    await page.keyboard.press("Space");
    await sleep(300);
    const bar = page.locator("[data-slot=data-table-bulk-bar]");
    check(await bar.isVisible(), "devices: Space on a row checkbox selects it and shows the bulk bar");
    const announced = await page.evaluate(() => [...document.querySelectorAll("[aria-live=polite]")].map((n) => n.textContent).join("|"));
    check(/1 selected/.test(announced), "devices: the selection is announced in a live region", announced);
    await axe(page, "devices with a selected row");
    await bar.getByRole("button", { name: "Clear" }).focus();
    await page.keyboard.press("Enter");
    await sleep(300);
    check((await focused(page)) !== "body", "devices: Clear keeps keyboard focus on the page", await focused(page));
  }
  await close(s, "portal 1280");

  // 360px: the sidebar drawer.
  const m = await open({ width: 360, height: 780, http: ctxs.owner });
  await go(m.page, "/account/licenses");
  await hydrated(m.page);
  await modalCheck(m.page, "portal menu drawer (360)", m.page.getByRole("button", { name: "Open menu", exact: true }).first());
  await close(m, "portal 360");
}

// ---------- admin: console widgets ----------
async function scenarioAdmin(ctxs) {
  if (!ctxs.admin) return;
  const s = await open({ width: 1280, http: ctxs.admin });
  const { page } = s;
  await go(page, "/admin");
  await hydrated(page);

  // Module search combobox.
  await page.keyboard.press("Control+K");
  await sleep(200);
  const combo = page.locator("input[role=combobox]").first();
  check(await combo.evaluate((el) => el === document.activeElement), "module search: Ctrl+K focuses the combobox", await focused(page));
  await combo.pressSequentially("li", { delay: 40 });
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const facts = await combo.evaluate((el) => {
    const id = el.getAttribute("aria-activedescendant");
    return { expanded: el.getAttribute("aria-expanded"), selected: id ? document.getElementById(id)?.getAttribute("aria-selected") : null };
  });
  check(facts.expanded === "true" && facts.selected === "true", "module search: arrows move aria-activedescendant", JSON.stringify(facts));
  await axe(page, "module search (open)");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Overview range: a toggle-button group.
  const pressed = await page.locator("[role=group] button[aria-pressed]").count();
  check(pressed >= 4, "overview: the range options are toggle buttons (aria-pressed)", pressed);

  // Licenses: open a row's drawer from the keyboard, then a destructive dialog inside it.
  await go(page, "/admin/licenses");
  await hydrated(page);
  const openRow = page.locator("table button[aria-label^='Open ']").first();
  await openRow.waitFor({ timeout: 30_000 });
  await modalCheck(page, "license drawer", openRow, {
    afterOpen: async () => {
      // Destructive dialog (nested): reason required, typed id for Revoke, Escape cancels back into the drawer.
      const drawer = page.locator("[role=dialog][data-state=open]").last();
      const trigger = drawer.getByRole("button", { name: /^(Revoke|Suspend)$/ }).first();
      if ((await trigger.count()) === 0) return;
      await trigger.focus();
      const opener = await focused(page);
      await page.keyboard.press("Enter");
      const alert = page.locator("[role=alertdialog]");
      if (!check(await alert.waitFor({ timeout: 10_000 }).then(() => true, () => false), "destructive dialog: Enter opens an alertdialog")) return;
      await sleep(300);
      check(await focusInside(page, "[role=alertdialog]"), "destructive dialog: focus moves into it", await focused(page));
      const confirm = alert.locator("button[type=submit]");
      check(await confirm.isDisabled(), "destructive dialog: confirm is disabled until a reason is given");
      const reason = alert.locator("textarea");
      const labelled = await reason.evaluate((el) => el.labels?.[0]?.textContent?.trim() ?? "");
      check(labelled.length > 0, "destructive dialog: the reason field is labelled", labelled);
      await axe(page, "destructive dialog (open)");
      check(await trapped(page, "[role=alertdialog]"), "destructive dialog: Tab stays inside", await focused(page));
      await page.keyboard.press("Escape");
      await alert.waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
      await sleep(250);
      check((await focused(page)) === opener, "destructive dialog: Escape returns focus to its button in the drawer", `${await focused(page)} (opener ${opener})`);
    },
  });
  await close(s, "admin 1280");

  const m = await open({ width: 360, height: 780, http: ctxs.admin });
  await go(m.page, "/admin/orders");
  await hydrated(m.page);
  await modalCheck(m.page, "admin menu drawer (360)", m.page.getByRole("button", { name: "Open menu", exact: true }).first());
  await close(m, "admin 360");
}

// ---------- reflow, zoom and text spacing ----------
const TEXT_SPACING_CSS = `*, *::before, *::after { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p { margin-bottom: 2em !important; }`;

/** Page-level horizontal overflow and text clipped by an overflow:hidden/clip box (ignoring sr-only and scrollers). */
function layoutFacts() {
  const doc = document.documentElement;
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!(el instanceof HTMLElement) || el.closest("[aria-hidden=true],[hidden],nextjs-portal")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed" && el.getBoundingClientRect().width <= 1) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue; // sr-only and collapsed elements
    const hidesX = ["hidden", "clip"].includes(cs.overflowX);
    const hidesY = ["hidden", "clip"].includes(cs.overflowY);
    if (!hidesX && !hidesY) continue;
    // Only boxes whose own text is cut (decorative illustrations and image crops are aria-hidden or have no text).
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || [...el.children].some((c) => c.textContent?.trim() && getComputedStyle(c).display.startsWith("inline"));
    if (!ownText) continue;
    const cutX = hidesX && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis";
    const cutY = hidesY && el.scrollHeight > el.clientHeight + 2 && !cs.webkitLineClamp?.match(/^\d/);
    if (cutX || cutY) clipped.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} "${el.textContent.trim().slice(0, 40)}" ${cutX ? "x" : ""}${cutY ? "y" : ""}`);
  }
  return { overflow: doc.scrollWidth - doc.clientWidth, clipped: clipped.slice(0, 8) };
}

async function scenarioReflow(ctxs) {
  const store = ["/", "/software", "/software/medical-billing", "/pricing", "/compare?ids=medical-billing,cheque-printing", "/about", "/contact", "/support", "/docs", "/legal/terms", "/cart", "/sign-in", "/register"];
  const portal = ["/account", "/account/licenses", `/account/licenses/${ctxs.license}`, "/account/devices", "/account/orders", "/account/billing", "/account/tickets/new", "/account/security"];
  const admin = ["/admin", "/admin/orders", "/admin/licenses", "/admin/settings", "/admin/reports"];
  const sets = [
    { label: "store", paths: store, http: null },
    { label: "portal", paths: portal, http: ctxs.owner },
    { label: "admin", paths: admin, http: ctxs.admin },
  ];
  for (const set of sets) {
    if (set.label !== "store" && !set.http) continue;
    // 320 CSS px = 1280px at 400% (WCAG 1.4.10); 640 = 200% zoom (1.4.4); text spacing at 360 and 1280 (1.4.12).
    for (const width of [320, 640]) {
      const s = await open({ width, height: width === 320 ? 640 : 450, http: set.http });
      for (const p of set.paths) {
        await go(s.page, p);
        await sleep(300);
        const f = await s.page.evaluate(layoutFacts);
        check(f.overflow <= 0, `${p} @${width}px: no horizontal page scroll`, `${f.overflow}px`);
        check(f.clipped.length === 0, `${p} @${width}px: no clipped text`, f.clipped.join(" | "));
      }
      await close(s, `${set.label} reflow ${width}`);
    }
    for (const width of [360, 1280]) {
      const s = await open({ width, height: 800, http: set.http });
      for (const p of set.paths) {
        await go(s.page, p);
        await s.page.addStyleTag({ content: TEXT_SPACING_CSS });
        await sleep(300);
        const f = await s.page.evaluate(layoutFacts);
        check(f.overflow <= 0, `${p} @${width}px with text spacing: no horizontal page scroll`, `${f.overflow}px`);
        check(f.clipped.length === 0, `${p} @${width}px with text spacing: no clipped text`, f.clipped.join(" | "));
      }
      await close(s, `${set.label} text spacing ${width}`);
    }
  }
}

// ---------- motion: prefers-reduced-motion ----------
async function scenarioMotion(ctxs) {
  const s = await open({ width: 1280, reducedMotion: "reduce", http: ctxs.owner ?? null });
  for (const p of ["/", "/software/medical-billing", "/pricing", "/account", "/account/licenses"]) {
    await go(s.page, p);
    await sleep(300);
    const f = await s.page.evaluate(() => {
      const long = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        const dur = (v) => Math.max(...v.split(",").map((x) => parseFloat(x) * (x.trim().endsWith("ms") ? 1 : 1000)));
        if (cs.animationName !== "none" && dur(cs.animationDuration) > 1) long.push(`${el.tagName.toLowerCase()} animation ${cs.animationName} ${cs.animationDuration}`);
        if (cs.transitionProperty !== "none" && cs.transitionProperty !== "all" && dur(cs.transitionDuration) > 1) long.push(`${el.tagName.toLowerCase()} transition ${cs.transitionDuration}`);
      }
      return { long: [...new Set(long)].slice(0, 6), smooth: getComputedStyle(document.documentElement).scrollBehavior };
    });
    check(f.long.length === 0, `${p}: no animation or transition longer than 1ms with reduced motion`, f.long.join(" | "));
    check(f.smooth !== "smooth", `${p}: smooth scrolling is off with reduced motion`, f.smooth);
  }
  await close(s, "motion");
}

// ---------- forced colours (Windows contrast themes) ----------
/** Computed colours in the page: the system Highlight and Canvas, and a few properties of `selector`. */
async function forcedFacts(page, selector) {
  return page.evaluate((sel) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.backgroundColor = "Highlight";
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = "Canvas";
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const el = document.querySelector(sel);
    if (!el) return { missing: true, highlight, canvas };
    const cs = getComputedStyle(el);
    return {
      highlight,
      canvas,
      bg: cs.backgroundColor,
      color: cs.color,
      border: parseFloat(cs.borderTopWidth),
      outline: cs.outlineStyle === "none" ? 0 : parseFloat(cs.outlineWidth),
    };
  }, selector);
}

async function scenarioForced(ctxs) {
  const s = await open({ width: 1280 });
  const { page } = s;
  await page.emulateMedia({ forcedColors: "active" });

  await go(page, "/sign-in");
  await hydrated(page, "#sign-in-email");
  await page.locator("#sign-in-email").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  let f = await forcedFacts(page, "#sign-in-email");
  check(f.outline >= 2, "forced colours: a focused text field shows an outline", JSON.stringify(f));
  f = await forcedFacts(page, "main form button[type=submit]");
  check(f.border >= 1, "forced colours: a solid button keeps a border", JSON.stringify(f));

  await go(page, "/pricing");
  await hydrated(page);
  f = await forcedFacts(page, "[data-price-toggle] button[aria-pressed=true]");
  check(!f.missing && f.bg === f.highlight, "forced colours: the pressed price option uses Highlight", JSON.stringify(f));
  f = await forcedFacts(page, "header nav a[aria-current=page]");
  check(!f.missing && f.bg === f.highlight, "forced colours: the current header link uses Highlight", JSON.stringify(f));
  await close(s, "forced colours store");

  if (ctxs.owner) {
    const o = await open({ width: 1280, http: ctxs.owner });
    await o.page.emulateMedia({ forcedColors: "active" });
    await go(o.page, `/account/licenses/${ctxs.license}`);
    await hydrated(o.page);
    f = await forcedFacts(o.page, "[role=tab][aria-selected=true]");
    check(!f.missing && f.bg === f.highlight, "forced colours: the selected tab uses Highlight", JSON.stringify(f));
    f = await forcedFacts(o.page, "aside a[aria-current=page]");
    check(!f.missing && f.bg === f.highlight, "forced colours: the current sidebar link uses Highlight", JSON.stringify(f));
    await go(o.page, "/account/security");
    await hydrated(o.page);
    f = await forcedFacts(o.page, "[role=switch]");
    check(!f.missing && f.border >= 1, "forced colours: a switch keeps an outlined track", JSON.stringify(f));
    f = await forcedFacts(o.page, "[role=switch] [data-slot=switch-thumb]");
    check(!f.missing && f.bg !== f.canvas, "forced colours: the switch thumb is drawn in a system text colour", JSON.stringify(f));
    await o.page.locator("header button[aria-label='Help']").first().focus();
    await o.page.keyboard.press("Enter");
    await o.page.locator("[role=menu]").waitFor({ timeout: 10_000 }).catch(() => undefined);
    await sleep(300);
    f = await forcedFacts(o.page, "[role=menuitem][data-highlighted]");
    check(!f.missing && f.bg === f.highlight, "forced colours: the highlighted menu item uses Highlight", JSON.stringify(f));
    await o.page.keyboard.press("Escape");
    await close(o, "forced colours portal");
  }
}

// ---------- run ----------
const SCENARIOS = {
  focus: scenarioFocus,
  store: scenarioStore,
  auth: scenarioAuth,
  orders: scenarioOrders,
  portal: scenarioPortal,
  admin: scenarioAdmin,
  reflow: scenarioReflow,
  motion: scenarioMotion,
  forced: scenarioForced,
};

await db.connect();
browser = await chromium.launch({ channel: "chrome", headless: true });
const ctxs = {};
try {
  current = "setup";
  const needOwner = ["focus", "portal", "orders", "reflow", "motion", "forced"].some((k) => ONLY.has(k));
  const needAdmin = ["focus", "admin", "reflow"].some((k) => ONLY.has(k));
  if (needOwner) {
    ctxs.owner = await signIn(PEOPLE.owner).catch((e) => (check(false, `${PEOPLE.owner.label} signs in`, e.message), null));
    const lic = await one(
      `SELECT l.id FROM "License" l JOIN "AccountMember" m ON m."accountId" = l."accountId" JOIN "User" u ON u.id = m."userId"
        WHERE u.email = $1 AND m.role = 'OWNER' AND l.status = 'ACTIVE' ORDER BY l.id LIMIT 1`,
      [PEOPLE.owner.email],
    );
    ctxs.license = lic?.id ?? "unknown";
  }
  if (needAdmin) ctxs.admin = await signIn(PEOPLE.admin).catch((e) => (check(false, `${PEOPLE.admin.label} signs in`, e.message), null));
  for (const [key, run] of Object.entries(SCENARIOS)) {
    if (!ONLY.has(key)) continue;
    current = key;
    try {
      await run(ctxs);
    } catch (error) {
      check(false, `${key} scenario finished`, error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" ") : String(error));
    }
  }
} finally {
  await signOutAll();
  await browser.close();
  await db.end();
}

const failed = results.filter((r) => !r.ok);
console.info(`\n${results.length} checks, ${failed.length} failed.`);
for (const f of failed) console.info(`FAIL [${f.scenario}] ${f.label}${f.detail ? ` -> ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
