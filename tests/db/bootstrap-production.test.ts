import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { canSignIn } from "@/lib/auth/flows/common";
import { needsRehash, verifyPassword } from "@/lib/auth/password";
import { SETTING_KEYS, getSettings } from "@/lib/config";
import { nextCounterValue, nextCreditNoteNumber, nextInvoiceNumber, nextLicenseId, nextOrderId, nextTicketId } from "@/lib/counters";
import { createPrismaClient } from "@/lib/db";
import { LEAD_COUNTER_KEY, LEAD_COUNTER_START } from "@/lib/leads";
import { latestRelease, mainPlans, newestRelease, startingPlan } from "@/lib/storefront/derive";
import { loadFaqs, loadStoreCategories, loadStoreProducts, loadStoreSettings } from "@/lib/storefront/prisma-source";
import {
  BOOTSTRAP_AUDIT,
  BootstrapError,
  TEST_MODE_NOTICE_TEXT,
  buildBootstrapRows,
  readBootstrapConfig,
  runBootstrap,
  type BootstrapOwnerInput,
} from "@/prisma/seed-data/bootstrap";

/**
 * The production bootstrap must see an EMPTY database, and the other DB test files share one schema, so this file
 * migrates its own schema (like tests/db/global-setup.ts) and drops it afterwards. The first runs go through the real
 * CLI (node --import tsx scripts/bootstrap-production.ts, what `pnpm exec tsx` runs on the server), the rest call
 * runBootstrap() directly.
 */
const base = process.env.TEST_DATABASE_URL;
const schema = `bootstrap_${process.pid}_${Date.now().toString(36)}`;
let url = "";
let db: PrismaClient;

// Random per run and never printed; the CLI output is checked for it.
const PASSWORD = `Owner-${randomBytes(9).toString("hex")}-7q`;
const OWNER_EMAIL = "founder@bootstrap-test.axiomaticsoftwaresolutions.com";
const OWNER_ENV = { BOOTSTRAP_OWNER_EMAIL: OWNER_EMAIL, BOOTSTRAP_OWNER_PASSWORD: PASSWORD, BOOTSTRAP_OWNER_NAME: "Asha Rao" };
/** A Razorpay test key id selects the test-mode sample notice. */
const TEST_PAYMENTS = { PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_bootstrap" };
const OWNER: BootstrapOwnerInput = { email: OWNER_EMAIL, name: "Asha Rao", password: PASSWORD };
const rows = buildBootstrapRows(readBootstrapConfig({}));
const SLOW = 180_000;

beforeAll(() => {
  if (!base) throw new Error("TEST_DATABASE_URL is not set (see .env.example).");
  const target = new URL(base);
  target.searchParams.set("schema", schema);
  url = target.toString();
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: "pipe" });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`prisma migrate deploy failed:\n${[stderr?.toString("utf8"), stdout?.toString("utf8")].filter(Boolean).join("\n")}`);
  }
  db = createPrismaClient(url);
}, SLOW);

afterAll(async () => {
  await db?.$disconnect();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (!base) return;
  const plain = new URL(base);
  plain.searchParams.delete("schema");
  const pg = new Client({ connectionString: plain.toString() });
  await pg.connect();
  try {
    await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pg.end();
  }
});

/** Row count of every table, one query each. */
const TABLES = {
  users: () => db.user.count(), sessions: () => db.session.count(), authTokens: () => db.authToken.count(),
  rateLimitBuckets: () => db.rateLimitBucket.count(), businessAccounts: () => db.businessAccount.count(),
  accountMembers: () => db.accountMember.count(), locations: () => db.location.count(),
  accountActivity: () => db.accountActivity.count(), categories: () => db.category.count(),
  products: () => db.product.count(), plans: () => db.plan.count(), releases: () => db.release.count(),
  releaseFiles: () => db.releaseFile.count(), downloadEvents: () => db.downloadEvent.count(),
  orders: () => db.order.count(), orderItems: () => db.orderItem.count(), payments: () => db.payment.count(),
  webhookEvents: () => db.webhookEvent.count(), webhookDeliveries: () => db.webhookDelivery.count(),
  refunds: () => db.refund.count(), invoices: () => db.invoice.count(), counters: () => db.counter.count(),
  licenses: () => db.license.count(), deviceActivations: () => db.deviceActivation.count(),
  licenseEvents: () => db.licenseEvent.count(), coupons: () => db.coupon.count(),
  couponRedemptions: () => db.couponRedemption.count(), supportTickets: () => db.supportTicket.count(),
  ticketMessages: () => db.ticketMessage.count(), outboxEmails: () => db.outboxEmail.count(),
  leads: () => db.lead.count(), uploads: () => db.upload.count(), notifications: () => db.notification.count(),
  notificationTemplates: () => db.notificationTemplate.count(), faqs: () => db.faq.count(),
  siteSettings: () => db.siteSetting.count(), auditLogs: () => db.auditLog.count(),
} satisfies Record<string, () => Promise<number>>;
type Table = keyof typeof TABLES;
type Counts = Record<Table, number>;

async function counts(): Promise<Counts> {
  const out = {} as Counts;
  for (const table of Object.keys(TABLES) as Table[]) out[table] = await TABLES[table]();
  return out;
}

/** Tables that hold customers, money, licenses or support work: production starts with none. */
const CUSTOMER_TABLES: readonly Table[] = [
  "sessions", "authTokens", "businessAccounts", "accountMembers", "locations", "accountActivity", "releaseFiles",
  "downloadEvents", "orders", "orderItems", "payments", "webhookEvents", "webhookDeliveries", "refunds", "invoices",
  "licenses", "deviceActivations", "licenseEvents", "coupons", "couponRedemptions", "supportTickets", "ticketMessages",
  "outboxEmails", "leads", "uploads", "notifications",
];

/** Runs the CLI against this file's schema from the project root. Inherited BOOTSTRAP_* variables are dropped. */
function runCli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
  for (const key of Object.keys(env)) if (key.startsWith("BOOTSTRAP_")) delete env[key];
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/bootstrap-production.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8", timeout: SLOW });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const tempDirs: string[] = [];
const root = process.cwd();
const tsxLoader = pathToFileURL(createRequire(join(root, "package.json")).resolve("tsx")).href;

/**
 * Runs the CLI like the server does: from a release directory whose .env.production holds the settings, with NODE_ENV
 * unset and nothing else in the environment (inherited DATABASE_URL, NODE_ENV, PAYMENT_* and BOOTSTRAP_* are removed).
 * A temporary directory stands in for the release, so tsx gets the project's tsconfig.json explicitly.
 */
function runCliWithEnvFile(args: string[], file: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "axs-bootstrap-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, ".env.production"), file);
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(root, "tsconfig.json") };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BOOTSTRAP_") || key.startsWith("PAYMENT_") || key === "DATABASE_URL" || key === "NODE_ENV") delete env[key];
  }
  const script = join(root, "scripts", "bootstrap-production.ts");
  const result = spawnSync(process.execPath, ["--import", tsxLoader, script, ...args], { cwd: dir, env, encoding: "utf8", timeout: SLOW });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** .env files expand `$NAME`; a literal `$` in the URL (e.g. in a password) is written as `\$`. */
const envFileUrl = () => url.split("$").join(`${String.fromCharCode(92)}$`);

const run = (options: { owner?: BootstrapOwnerInput | null; dryRun?: boolean; updateCatalog?: boolean } = {}) =>
  runBootstrap(db, { rows, owner: options.owner === undefined ? OWNER : options.owner, dryRun: options.dryRun ?? false, updateCatalog: options.updateCatalog ?? false });

describe("production bootstrap on an empty database", () => {
  it("reads .env.production when NODE_ENV is unset, and --dry-run writes nothing", async () => {
    const file = [
      `DATABASE_URL=${envFileUrl()}`,
      `BOOTSTRAP_OWNER_EMAIL=${OWNER_EMAIL}`,
      `BOOTSTRAP_OWNER_PASSWORD=${PASSWORD}`,
      'BOOTSTRAP_OWNER_NAME="Asha Rao"',
      "",
    ].join("\n");
    const { status, output } = runCliWithEnvFile(["--dry-run"], file);
    expect(output).toContain("Environment: production; .env files read: .env.production.");
    expect(output).toMatch(/DRY RUN: nothing was written/);
    expect(status).toBe(0);
    expect(output).toContain(`would create ${OWNER_EMAIL} ("Asha Rao")`);
    // No PAYMENT_PROVIDER in the file = the app's default mock provider = test mode wording.
    expect(output).toContain(`Sample notice: on, "${TEST_MODE_NOTICE_TEXT}"`);
    expect(output).toContain("BOOTSTRAP_OWNER_PASSWORD is read from .env.production. After the real run, delete that line");
    expect(output).not.toContain(PASSWORD);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  }, SLOW);

  it("refuses an Owner password that reading .env.production would change, without printing it", async () => {
    const secret = `Pa$word${randomBytes(6).toString("hex")}-9`;
    const file = [`DATABASE_URL=${envFileUrl()}`, `BOOTSTRAP_OWNER_EMAIL=${OWNER_EMAIL}`, `BOOTSTRAP_OWNER_PASSWORD=${secret}`, ""].join("\n");
    const { status, output } = runCliWithEnvFile([], file);
    expect(status).toBe(1);
    expect(output).toContain("BOOTSTRAP_OWNER_PASSWORD: reading .env.production changes this password");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(secret.indexOf("word")));
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  }, SLOW);

  it("--dry-run plans every row and writes nothing", async () => {
    const { status, output } = runCli(["--dry-run"], OWNER_ENV);
    expect(output).toMatch(/DRY RUN: nothing was written/);
    expect(status).toBe(0);
    expect(output).toContain(`would create ${String(rows.products.length).padStart(3)}`);
    expect(output).toContain(OWNER_EMAIL);
    expect(output).not.toContain(PASSWORD);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  }, SLOW);

  it("refuses an Owner address that already belongs to a customer, and writes nothing", async () => {
    await db.user.create({ data: { id: "bootstrap_test_customer", email: OWNER_EMAIL, name: "Customer" } });
    try {
      await expect(run()).rejects.toThrow(/already belongs to a customer account/);
      expect((await counts()).users).toBe(1);
      expect((await counts()).categories).toBe(0);
    } finally {
      await db.user.delete({ where: { id: "bootstrap_test_customer" } });
    }
  });

  it("refuses a database that went through the dev seed", async () => {
    await db.user.create({ data: { id: "seed_user_priya", email: "priya@sharmamedicals.example", name: "Priya" } });
    try {
      await expect(run({ dryRun: true })).rejects.toThrow(/development seed data/);
      await expect(run()).rejects.toBeInstanceOf(BootstrapError);
    } finally {
      await db.user.delete({ where: { id: "seed_user_priya" } });
    }
  });

  it("refuses to run without an Owner when none exists", async () => {
    await expect(run({ owner: null })).rejects.toThrow(/No Owner exists yet/);
  });

  it("the first run writes the catalog, content, settings, counters and the Owner, and no customer data", async () => {
    const { status, output } = runCli([], { ...OWNER_ENV, ...TEST_PAYMENTS });
    expect(output).toMatch(/Production bootstrap - done/);
    expect(status).toBe(0);
    expect(output).not.toContain(PASSWORD);

    const after = await counts();
    expect(after).toMatchObject({
      users: 1,
      categories: rows.categories.length,
      products: rows.products.length,
      plans: rows.plans.length,
      releases: rows.releases.length,
      faqs: rows.faqs.length,
      notificationTemplates: rows.templates.length,
      siteSettings: 5,
      counters: 4,
      auditLogs: 1,
    });
    for (const table of CUSTOMER_TABLES) expect({ table, rows: after[table] }).toEqual({ table, rows: 0 });

    expect(await db.product.count({ where: { status: "PUBLISHED" } })).toBe(rows.products.length);
    expect(await db.release.count({ where: { status: "DRAFT", releasedAt: null } })).toBe(rows.releases.length);
    expect(await db.counter.findMany({ orderBy: { key: "asc" } })).toEqual([
      { key: "lead", next: 1001 },
      { key: "license", next: 20001 },
      { key: "order", next: 10001 },
      { key: "ticket", next: 1001 },
    ]);
    const settings = new Map((await db.siteSetting.findMany()).map((s) => [s.key, s.value]));
    expect(settings.get("business")).toMatchObject({ sample: true });
    expect(settings.get("content.sampleNotice")).toEqual({ enabled: true, text: TEST_MODE_NOTICE_TEXT });
    expect(settings.get("content.banner")).toMatchObject({ enabled: false });
    // The app reads back exactly what was stored (an invalid value would silently fall back to the defaults).
    const read = await getSettings(db);
    for (const key of SETTING_KEYS) expect({ key, value: read[key] }).toEqual({ key, value: settings.get(key) });

    const audit = await db.auditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: null, actorRole: "system", action: "Bootstrapped production data", targetType: BOOTSTRAP_AUDIT.targetType, targetId: BOOTSTRAP_AUDIT.targetId });
    expect(audit[0]?.detail).toContain("Created the Owner account.");
    expect(audit[0]?.detail).not.toContain(PASSWORD);
  }, SLOW);

  it("the Owner is an active, verified, two-step staff Owner who can sign in with the password", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    expect(owner).toMatchObject({ kind: "STAFF", staffRole: "OWNER", staffStatus: "ACTIVE", twoStepEnabled: true, name: "Asha Rao" });
    expect(owner.emailVerifiedAt).toBeInstanceOf(Date);
    expect(owner.passwordHash).toMatch(/^[$]argon2id[$]/);
    expect(needsRehash(owner.passwordHash ?? "")).toBe(false);
    expect(await verifyPassword(PASSWORD, owner.passwordHash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, owner.passwordHash)).toBe(false);
    expect(canSignIn(owner)).toBe(true);
  });

  it("the storefront loaders (what `next build` prerenders) read a complete catalog with no release yet", async () => {
    const products = await loadStoreProducts(db);
    const byRank = [...rows.products].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name));
    expect(products.map((p) => p.id)).toEqual(byRank.map((p) => p.id));
    for (const product of products) {
      expect({ id: product.id, plans: mainPlans(product).length > 0, from: startingPlan(product) !== null }).toEqual({ id: product.id, plans: true, from: true });
      expect(product.faqs.length).toBeGreaterThan(0);
      expect(latestRelease(product)).toBeNull();
    }
    expect(newestRelease(products)).toBeNull();
    const categories = await loadStoreCategories(db);
    expect(categories.map((c) => c.id)).toEqual(rows.categories.map((c) => c.id));
    expect(categories.reduce((n, c) => n + c.productCount, 0)).toBe(rows.products.length);
    for (const page of ["home", "pricing", "support"]) expect((await loadFaqs(db, page)).length).toBeGreaterThan(0);
    expect((await loadStoreSettings(db))["content.sampleNotice"]).toEqual({ enabled: true, text: TEST_MODE_NOTICE_TEXT });
  });

  it("the app then hands out AX-10001, LIC-20001, T-1001, lead 1001 and document number 0001 per financial year", async () => {
    const rollback = new Error("rollback");
    await expect(
      db.$transaction(async (tx) => {
        expect(await nextOrderId(tx)).toBe("AX-10001");
        expect(await nextLicenseId(tx)).toBe("LIC-20001");
        expect(await nextTicketId(tx)).toBe("T-1001");
        expect(await nextCounterValue(tx, LEAD_COUNTER_KEY, LEAD_COUNTER_START)).toBe(1001);
        expect(await nextInvoiceNumber(tx, new Date("2026-10-07T06:00:00Z"))).toBe("AXS/26-27/0001");
        expect(await nextInvoiceNumber(tx, new Date("2027-04-01T06:00:00Z"))).toBe("AXS/27-28/0001");
        expect(await nextCreditNoteNumber(tx, new Date("2026-10-07T06:00:00Z"))).toBe("AXC/26-27/0001");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.counter.count()).toBe(4);
  });
});

describe("production bootstrap on later runs", () => {
  it("a second run is a no-op: identical counts, the Owner untouched, no new audit row", async () => {
    const before = await counts();
    const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    const product = await db.product.findUniqueOrThrow({ where: { id: rows.products[0]?.id ?? "" } });

    const report = await run();
    expect(report.changed).toBe(false);
    expect(report.plan.catalog).toBe("skip");
    expect(report.plan.owner).toEqual({ action: "keep", email: OWNER_EMAIL });
    expect(await counts()).toEqual(before);
    expect((await db.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } })).passwordHash).toBe(owner.passwordHash);
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).updatedAt).toEqual(product.updatedAt);

    const cli = runCli([], OWNER_ENV);
    expect(cli.output).toMatch(/nothing to do/);
    expect(cli.status).toBe(0);
    expect(await counts()).toEqual(before);
  }, SLOW);

  it("runs without BOOTSTRAP_OWNER_* once an Owner exists, and --dry-run still writes nothing", async () => {
    const before = await counts();
    expect((await run({ owner: null })).plan.owner).toEqual({ action: "none", email: OWNER_EMAIL });
    const dry = await run({ owner: null, dryRun: true, updateCatalog: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.plan.catalog).toBe("update");
    expect(await counts()).toEqual(before);
  });

  it("never creates a second Owner, and writes nothing when asked to", async () => {
    const before = await counts();
    await expect(run({ owner: { ...OWNER, email: "second.owner@axiomaticsoftwaresolutions.com" } })).rejects.toThrow(
      /An Owner already exists \(founder@bootstrap-test[.]axiomaticsoftwaresolutions[.]com\)/,
    );
    const cli = runCli([], { ...OWNER_ENV, BOOTSTRAP_OWNER_EMAIL: "second.owner@axiomaticsoftwaresolutions.com" });
    expect(cli.status).toBe(1);
    expect(cli.output).toMatch(/BootstrapError: An Owner already exists/);
    expect(cli.output).not.toContain(PASSWORD);
    expect(await counts()).toEqual(before);
    expect(await db.user.count({ where: { staffRole: "OWNER" } })).toBe(1);
  }, SLOW);

  it("--update-catalog re-applies copy and prices from code but keeps admin switches, releases and settings", async () => {
    const plan = rows.plans[0];
    const product = rows.products.find((p) => p.id === plan?.productId);
    const faq = rows.faqs[0];
    const deletedFaq = rows.faqs[1];
    const template = rows.templates[0];
    const category = rows.categories[0];
    const release = rows.releases[0];
    if (!plan || !product || !faq || !deletedFaq || !template || !category || !release) throw new Error("rows missing");

    // Admin edits since the first run.
    await db.plan.update({ where: { id: plan.id }, data: { pricePaise: 100, archived: true } });
    await db.product.update({ where: { id: product.id }, data: { tagline: "Edited", status: "HIDDEN" } });
    await db.faq.update({ where: { id: faq.id }, data: { answer: "Edited", published: false, sortOrder: 90 } });
    await db.faq.delete({ where: { id: deletedFaq.id } });
    await db.notificationTemplate.update({ where: { id: template.id }, data: { subject: "Edited", active: false } });
    await db.category.update({ where: { id: category.id }, data: { name: "Edited" } });
    await db.release.update({ where: { id: release.id }, data: { notes: ["Edited by admin"] } });
    await db.siteSetting.update({ where: { key: "tax" }, data: { value: { gstRatePct: 12, sac: "997331", priceDisplay: "exclusive", invoicePrefix: "AXS", creditNotePrefix: "AXC" } } });
    const before = await counts();

    const report = await run({ owner: null, updateCatalog: true });
    expect(report.changed).toBe(true);
    expect(report.plan.faqs.create.map((f) => f.id)).toEqual([deletedFaq.id]);
    expect(report.plan.releases.create).toEqual([]);

    expect(await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ pricePaise: plan.pricePaise, archived: true });
    expect(await db.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ tagline: product.tagline, status: "HIDDEN" });
    expect(await db.faq.findUniqueOrThrow({ where: { id: faq.id } })).toMatchObject({ answer: faq.answer, published: false, sortOrder: 90 });
    expect(await db.notificationTemplate.findUniqueOrThrow({ where: { id: template.id } })).toMatchObject({ subject: template.subject, active: false });
    expect((await db.category.findUniqueOrThrow({ where: { id: category.id } })).name).toBe(category.name);
    expect((await db.release.findUniqueOrThrow({ where: { id: release.id } })).notes).toEqual(["Edited by admin"]);
    expect((await db.siteSetting.findUniqueOrThrow({ where: { key: "tax" } })).value).toMatchObject({ gstRatePct: 12 });

    const after = await counts();
    expect(after).toEqual({ ...before, faqs: before.faqs + 1, auditLogs: before.auditLogs + 1 });
    for (const table of CUSTOMER_TABLES) expect(after[table]).toBe(0);
    const last = await db.auditLog.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(last.action).toBe("Refreshed catalog from code");

    const again = await run({ owner: null, updateCatalog: true });
    expect(again.changed).toBe(false);
    expect(await counts()).toEqual(after);
  });
});
