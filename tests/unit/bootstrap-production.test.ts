import { describe, expect, it } from "vitest";
import { PublishStatus, ReleaseStatus } from "@/generated/prisma/enums";
import { SETTING_DEFAULTS, SETTING_KEYS, settingSchemas } from "@/lib/config";
import { compareVersions } from "@/lib/licensing/entitlement";
import { LEAD_COUNTER_KEY, LEAD_COUNTER_START } from "@/lib/leads";
import {
  BOOTSTRAP_COUNTERS,
  BUSINESS_ENV,
  BootstrapError,
  DEFAULT_OWNER_NAME,
  TEST_MODE_NOTICE_TEXT,
  UPDATE_FIELDS,
  buildBootstrapRows,
  diffRows,
  formatBootstrapReport,
  isPaymentTestMode,
  isUndeliverableEmail,
  newestSeedRelease,
  ownerPasswordSource,
  readBootstrapConfig,
  sameValue,
  type BootstrapPlan,
} from "@/prisma/seed-data/bootstrap";
import { PRODUCTS } from "@/prisma/seed-data/catalog";
import { SAMPLE_NOTICE_TEXT, SEED_SETTINGS } from "@/prisma/seed-data/content";
import { buildSeedPlan } from "@/prisma/seed-data/plan";

const PASSWORD = "Bootstrap-Owner-Pass-42";
const OWNER = { BOOTSTRAP_OWNER_EMAIL: "  Founder@AxiomaticSoftwareSolutions.com ", BOOTSTRAP_OWNER_PASSWORD: PASSWORD };
const REAL_SELLER = {
  BOOTSTRAP_BUSINESS_LEGAL_NAME: "Axiomatic Software Solutions Pvt. Ltd.",
  BOOTSTRAP_BUSINESS_GSTIN: "29AABCA1234D1Z5",
  BOOTSTRAP_BUSINESS_ADDRESS: "12 MG Road",
  BOOTSTRAP_BUSINESS_CITY: "Bengaluru",
  BOOTSTRAP_BUSINESS_STATE: "Karnataka",
  BOOTSTRAP_BUSINESS_PIN: "560001",
};

/** Problems of a config that must fail; also proves no message ever echoes the password. */
function problemsOf(source: Record<string, string>): string[] {
  try {
    readBootstrapConfig(source);
  } catch (e) {
    expect(e).toBeInstanceOf(BootstrapError);
    const err = e as BootstrapError;
    expect(err.message).not.toContain(PASSWORD);
    for (const p of err.problems) expect(p).not.toContain(PASSWORD);
    return [...err.problems];
  }
  throw new Error("expected a BootstrapError");
}

const config = readBootstrapConfig({});
const rows = buildBootstrapRows(config);
const devPlan = buildSeedPlan({ now: new Date("2026-10-06T06:30:00.000Z"), ownerEmail: "owner@axiomatic.example" });

describe("buildBootstrapRows: catalog and content", () => {
  it("matches the dev seed's categories, products, plans and FAQs exactly (no drift between the two)", () => {
    expect(rows.categories).toEqual(devPlan.categories);
    expect(rows.products).toEqual(devPlan.products);
    expect(rows.plans).toEqual(devPlan.plans);
    expect(rows.faqs).toEqual(devPlan.faqs);
  });

  it("matches the dev seed's notification templates apart from the fake edit dates", () => {
    expect(rows.templates).toEqual(devPlan.templates.map(({ updatedAt: _updatedAt, ...t }) => t));
    expect(rows.templates.some((t) => "updatedAt" in t)).toBe(false);
  });

  it("publishes every product and keeps every plan on sale", () => {
    expect(rows.products.every((p) => p.status === PublishStatus.PUBLISHED)).toBe(true);
    expect(rows.plans.every((p) => p.archived === false)).toBe(true);
    expect(rows.categories.every((c) => typeof c.blurb === "string" && c.blurb.length > 0)).toBe(true);
  });

  it("seeds one DRAFT stable release per product: the newest sample version, notes only, never released", () => {
    expect(rows.releases).toHaveLength(PRODUCTS.length);
    for (const product of PRODUCTS) {
      const release = rows.releases.find((r) => r.productId === product.id);
      const newest = [...product.releases].map((r) => r.version).sort((a, b) => compareVersions(b, a))[0];
      expect(release?.version).toBe(newest);
      expect(release?.status).toBe(ReleaseStatus.DRAFT);
      expect(release?.channel).toBe("stable");
      expect(release?.releasedAt).toBeNull();
      expect((release?.notes as string[] | undefined)?.length ?? 0).toBeGreaterThan(0);
      expect(release?.id).toBe(devPlan.releases.find((r) => r.productId === product.id && r.version === newest)?.id);
    }
  });

  it("picks the newest release by version, not by list position", () => {
    const product = { releases: [{ version: "4.1.5", date: "2026-10-01", size: "1 MB", notes: [] }, { version: "4.10.0", date: "2026-01-01", size: "1 MB", notes: [] }] };
    expect(newestSeedRelease(product)?.version).toBe("4.10.0");
    expect(newestSeedRelease({ releases: [] })).toBeNull();
  });

  it("writes no sample people, orders, licenses, tickets or coupons", () => {
    expect(Object.keys(rows).sort()).toEqual(["categories", "counters", "faqs", "plans", "products", "releases", "settings", "templates"]);
  });
});

describe("buildBootstrapRows: settings and counters", () => {
  const settings = new Map(rows.settings.map((s) => [s.key, s.value]));

  it("writes every settings section, each valid for the strict admin schemas", () => {
    expect([...settings.keys()]).toEqual([...SETTING_KEYS]);
    for (const key of SETTING_KEYS) expect(settingSchemas[key].safeParse(settings.get(key)).success).toBe(true);
  });

  it("uses the SAMPLE business placeholders, the tax and licensing defaults, banner off, sample notice on", () => {
    expect(settings.get("business")).toEqual(SEED_SETTINGS.business);
    expect(settings.get("tax")).toEqual(SEED_SETTINGS.tax);
    expect(settings.get("licensing")).toEqual(SEED_SETTINGS.licensing);
    expect(settings.get("content.banner")).toEqual(SETTING_DEFAULTS["content.banner"]);
    // No PAYMENT_PROVIDER = the app's default mock provider, i.e. test mode.
    expect(settings.get("content.sampleNotice")).toEqual({ enabled: true, text: TEST_MODE_NOTICE_TEXT });
  });

  it("starts production counters fresh: AX-10001, LIC-20001, T-1001 and leads at the app's own start", () => {
    expect(rows.counters).toEqual([
      { key: "order", next: 10001 },
      { key: "license", next: 20001 },
      { key: "ticket", next: 1001 },
      { key: LEAD_COUNTER_KEY, next: LEAD_COUNTER_START },
    ]);
    expect(rows.counters).toEqual(BOOTSTRAP_COUNTERS);
    expect(rows.counters.some((c) => c.key.startsWith("invoice") || c.key.startsWith("creditnote"))).toBe(false);
  });
});

describe("readBootstrapConfig: owner", () => {
  it("has no owner when no BOOTSTRAP_OWNER_* is set", () => {
    expect(readBootstrapConfig({}).owner).toBeNull();
  });

  it("normalises the email, keeps the password exactly and defaults the name", () => {
    expect(readBootstrapConfig(OWNER).owner).toEqual({ email: "founder@axiomaticsoftwaresolutions.com", name: DEFAULT_OWNER_NAME, password: PASSWORD });
    expect(readBootstrapConfig({ ...OWNER, BOOTSTRAP_OWNER_NAME: " Asha Rao " }).owner?.name).toBe("Asha Rao");
    const spaced = ` ${PASSWORD} `;
    expect(readBootstrapConfig({ ...OWNER, BOOTSTRAP_OWNER_PASSWORD: spaced }).owner?.password).toBe(spaced);
  });

  it("needs the email and the password together", () => {
    expect(problemsOf({ BOOTSTRAP_OWNER_EMAIL: OWNER.BOOTSTRAP_OWNER_EMAIL })).toEqual([
      "BOOTSTRAP_OWNER_PASSWORD: is required with BOOTSTRAP_OWNER_EMAIL",
    ]);
    expect(problemsOf({ BOOTSTRAP_OWNER_PASSWORD: PASSWORD })[0]).toMatch(/^BOOTSTRAP_OWNER_EMAIL: is required/);
    expect(problemsOf({ BOOTSTRAP_OWNER_NAME: "Asha" }).length).toBe(2);
  });

  it("refuses weak and placeholder passwords without echoing them", () => {
    expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_PASSWORD: "short1" })).toEqual([
      "BOOTSTRAP_OWNER_PASSWORD: Use at least 8 characters with letters and a number.",
    ]);
    expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_PASSWORD: "change-me-123" })[0]).toMatch(/placeholder/);
    expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_PASSWORD: "x".repeat(129) + "1" })[0]).toMatch(/^BOOTSTRAP_OWNER_PASSWORD:/);
  });

  it("refuses addresses that can never receive the emailed sign-in code", () => {
    for (const email of ["owner@axiomatic.example", "a@b.test", "a@example.com", "a@mail.example.org", "a@host.localhost"]) {
      expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_EMAIL: email })[0]).toMatch(/^BOOTSTRAP_OWNER_EMAIL: must be a mailbox you can read/);
    }
    expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_EMAIL: "not-an-email" })).toEqual(["BOOTSTRAP_OWNER_EMAIL: is not a valid email address"]);
  });

  it("refuses names with links or email addresses", () => {
    expect(problemsOf({ ...OWNER, BOOTSTRAP_OWNER_NAME: "www.spam.example" })[0]).toMatch(/^BOOTSTRAP_OWNER_NAME: Enter your name without links/);
  });

  it("lists every problem at once", () => {
    const problems = problemsOf({ BOOTSTRAP_OWNER_EMAIL: "nope", BOOTSTRAP_OWNER_PASSWORD: "weak", BOOTSTRAP_BUSINESS_PIN: "12" });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["BOOTSTRAP_OWNER_EMAIL", "BOOTSTRAP_OWNER_PASSWORD", "BOOTSTRAP_BUSINESS_PIN"]);
  });
});

describe("readBootstrapConfig: business, sample flag and notice", () => {
  it("keeps the placeholders and sample: true by default, and warns about addresses that never receive mail", () => {
    const c = readBootstrapConfig({});
    expect(c.business).toEqual(SEED_SETTINGS.business);
    expect(c.businessSupplied).toEqual([]);
    expect(c.warnings.map((w) => w.split(" ")[1])).toEqual(["supportEmail", "salesEmail", "legalEmail", "privacyEmail"]);
  });

  it("applies supplied values over the placeholders and stays sample unless BOOTSTRAP_BUSINESS_SAMPLE=false", () => {
    const c = readBootstrapConfig({ ...REAL_SELLER, BOOTSTRAP_SALES_EMAIL: "Sales@AxiomaticSoftwareSolutions.com" });
    expect(c.business).toMatchObject({ legalName: REAL_SELLER.BOOTSTRAP_BUSINESS_LEGAL_NAME, state: "Karnataka", salesEmail: "sales@axiomaticsoftwaresolutions.com", sample: true });
    expect(c.businessSupplied).toEqual(["legalName", "gstin", "address", "city", "state", "pin", "salesEmail"]);
    expect(c.warnings.some((w) => w.includes("salesEmail"))).toBe(false);
    expect(readBootstrapConfig({ ...REAL_SELLER, BOOTSTRAP_BUSINESS_SAMPLE: "false" }).business.sample).toBe(false);
  });

  it("needs all six seller identity fields before sample may be false", () => {
    const problems = problemsOf({ BOOTSTRAP_BUSINESS_LEGAL_NAME: "Real Pvt Ltd", BOOTSTRAP_BUSINESS_SAMPLE: "false" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^BOOTSTRAP_BUSINESS_SAMPLE: false needs the real seller details/);
    for (const key of ["GSTIN", "ADDRESS", "CITY", "STATE", "PIN"]) expect(problems[0]).toContain(`BOOTSTRAP_BUSINESS_${key}`);
    expect(problemsOf({ BOOTSTRAP_BUSINESS_SAMPLE: "maybe" })).toEqual(["BOOTSTRAP_BUSINESS_SAMPLE: must be true or false"]);
  });

  it("reports app validation errors under the variable to change", () => {
    expect(problemsOf({ BOOTSTRAP_BUSINESS_STATE: "Karnataka" })[0]).toMatch(/^BOOTSTRAP_BUSINESS_GSTIN: .*sample placeholder/);
    expect(problemsOf({ ...REAL_SELLER, BOOTSTRAP_BUSINESS_GSTIN: "27AABCA1234D1Z5" })[0]).toMatch(/^BOOTSTRAP_BUSINESS_GSTIN: This GSTIN is registered in Maharashtra/);
    expect(problemsOf({ BOOTSTRAP_SUPPORT_EMAIL: "support" })[0]).toMatch(/^BOOTSTRAP_SUPPORT_EMAIL: /);
    expect(Object.values(BUSINESS_ENV).every((k) => k.startsWith("BOOTSTRAP_"))).toBe(true);
  });

  it("words the sample notice for test mode only while payments really are in test mode", () => {
    const notice = (source: Record<string, string>) => readBootstrapConfig(source).sampleNotice;
    expect(notice({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_AbC123" })).toEqual({ enabled: true, text: TEST_MODE_NOTICE_TEXT });
    expect(notice({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_live_AbC123" })).toEqual({ enabled: true, text: SAMPLE_NOTICE_TEXT });
    expect(notice({ PAYMENT_PROVIDER: "cashfree", PAYMENT_KEY_ID: "rzp_test_AbC123" })).toEqual({ enabled: true, text: SAMPLE_NOTICE_TEXT });
    expect(notice({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_x", BOOTSTRAP_SAMPLE_NOTICE_TEXT: "Own text" }).text).toBe("Own text");
    expect(isPaymentTestMode({})).toBe(true);
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "razorpay" })).toBe(false);
    expect(settingSchemas["content.sampleNotice"].safeParse({ enabled: true, text: TEST_MODE_NOTICE_TEXT }).success).toBe(true);
  });

  it("takes a custom sample notice of at most 200 characters", () => {
    const custom = readBootstrapConfig({ BOOTSTRAP_SAMPLE_NOTICE_TEXT: "Test site" });
    expect(custom.sampleNotice).toEqual({ enabled: true, text: "Test site" });
    expect(buildBootstrapRows(custom).settings.find((s) => s.key === "content.sampleNotice")?.value).toEqual({ enabled: true, text: "Test site" });
    expect(problemsOf({ BOOTSTRAP_SAMPLE_NOTICE_TEXT: "a".repeat(201) })).toEqual(["BOOTSTRAP_SAMPLE_NOTICE_TEXT: use 200 characters or fewer"]);
  });
});

describe("helpers", () => {
  it("isUndeliverableEmail only flags reserved domains", () => {
    expect(isUndeliverableEmail("a@axiomatic.example")).toBe(true);
    expect(isUndeliverableEmail("a@example.net")).toBe(true);
    expect(isUndeliverableEmail("a@gmail.com")).toBe(false);
    expect(isUndeliverableEmail("a@examples.com")).toBe(false);
    expect(isUndeliverableEmail("a@example.co.in")).toBe(false);
  });

  it("sameValue ignores jsonb key order and compares dates, bigints and arrays by value", () => {
    expect(sameValue({ b: 1, a: [1, { y: 2, x: 1 }] }, { a: [1, { x: 1, y: 2 }], b: 1 })).toBe(true);
    expect(sameValue(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(sameValue(10n, 10n)).toBe(true);
    expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameValue(undefined, null)).toBe(true);
  });
});

describe("ownerPasswordSource: .env files that would change the Owner password", () => {
  const file = (contents: string) => [{ path: ".env.production", contents }];

  it("ignores the files when the password is in the process environment (env files never override it)", () => {
    expect(ownerPasswordSource(file("BOOTSTRAP_OWNER_PASSWORD=a$b"), true, "anything")).toEqual({ file: null, problem: null });
    expect(ownerPasswordSource(file("OTHER=1"), false, undefined)).toEqual({ file: null, problem: null });
  });

  it("accepts a value that reads back unchanged, quoted or not, and names the file", () => {
    expect(ownerPasswordSource(file(`BOOTSTRAP_OWNER_PASSWORD=${PASSWORD}`), false, PASSWORD)).toEqual({ file: ".env.production", problem: null });
    expect(ownerPasswordSource(file(`export BOOTSTRAP_OWNER_PASSWORD = "${PASSWORD}"`), false, PASSWORD).problem).toBeNull();
    expect(ownerPasswordSource(file(`BOOTSTRAP_OWNER_PASSWORD_OLD=x\nBOOTSTRAP_OWNER_PASSWORD='${PASSWORD}'`), false, PASSWORD).problem).toBeNull();
  });

  it("flags $ expansion, # comments and trimmed spaces without echoing the value", () => {
    // What @next/env made of each line (checked against @next/env 15.5).
    const cases: [string, string][] = [
      ["BOOTSTRAP_OWNER_PASSWORD=Secret$abc1", "Secret"],
      ["BOOTSTRAP_OWNER_PASSWORD='Secret$abc1'", "Secret"],
      ["BOOTSTRAP_OWNER_PASSWORD=Secret#abc1", "Secret"],
      ["BOOTSTRAP_OWNER_PASSWORD=\" Secret1 \"", " Secret1 "],
    ];
    for (const [line, loaded] of cases.slice(0, 3)) {
      const result = ownerPasswordSource(file(line), false, loaded);
      expect(result.file).toBe(".env.production");
      expect(result.problem).toMatch(/^BOOTSTRAP_OWNER_PASSWORD: reading [.]env[.]production changes this password/);
      expect(result.problem).not.toContain("abc1");
    }
    expect(ownerPasswordSource(file(cases[3]?.[0] ?? ""), false, " Secret1 ").problem).toBeNull();
    expect(ownerPasswordSource(file("BOOTSTRAP_OWNER_PASSWORD=  Secret1  "), false, "Secret1").problem).toBeNull();
  });

  it("checks the file @next/env took the value from: the first one that sets it, the last line in that file", () => {
    const files = [
      { path: ".env.local", contents: "OTHER=1" },
      { path: ".env.production", contents: "BOOTSTRAP_OWNER_PASSWORD=old1-value\nBOOTSTRAP_OWNER_PASSWORD=Has$dollar1" },
      { path: ".env", contents: `BOOTSTRAP_OWNER_PASSWORD=${PASSWORD}` },
    ];
    expect(ownerPasswordSource(files, false, "Has").file).toBe(".env.production");
    expect(ownerPasswordSource(files, false, "Has").problem).not.toBeNull();
  });
});

describe("diffRows and --update-catalog fields", () => {
  it("creates missing rows, keeps existing ones, and with update writes only the changed fields", () => {
    const desired = [{ id: "a", name: "A", price: 1 }, { id: "b", name: "B", price: 2 }, { id: "c", name: "C", price: 3 }];
    const stored = [{ id: "a", name: "A", price: 1 }, { id: "b", name: "Old", price: 2, extra: true }];
    expect(diffRows(desired, stored, ["name", "price"], false)).toEqual({ create: [desired[2]], update: [], kept: 2 });
    expect(diffRows(desired, stored, ["name", "price"], true)).toEqual({ create: [desired[2]], update: [{ id: "b", data: { name: "B" } }], kept: 1 });
  });

  it("never re-applies ids, product codes or the switches admins own", () => {
    const all: readonly string[] = Object.values(UPDATE_FIELDS).flat();
    for (const field of ["id", "code", "status", "archived", "published", "page", "active", "channel", "productId", "type", "createdAt"]) {
      expect(all).not.toContain(field);
    }
    // Categories and plans take their order from code; FAQs keep the order set with Move up / Move down.
    expect(UPDATE_FIELDS.faqs).not.toContain("sortOrder");
  });
});

describe("formatBootstrapReport", () => {
  const none = { create: [], update: [], kept: 0 };
  const plan: BootstrapPlan = {
    bootstrappedAt: null,
    catalog: "create",
    settings: { create: rows.settings, kept: 0 },
    categories: { ...none, create: rows.categories },
    products: { ...none, create: rows.products },
    plans: { ...none, create: rows.plans },
    releases: { create: rows.releases, kept: 0 },
    faqs: { ...none, create: rows.faqs },
    templates: { ...none, create: rows.templates },
    counters: { create: rows.counters, kept: [] },
    owner: { action: "create", email: "founder@axiomaticsoftwaresolutions.com", name: "Owner" },
    notices: ["n1"],
  };

  it("prints counts, counters, the Owner email and next steps, never row contents or the password", () => {
    const text = formatBootstrapReport({ dryRun: false, changed: true, plan }, { warnings: ["w1"], notes: ["x1"], appUrl: "https://shop.example.in" });
    expect(text).toContain("  - x1");
    expect(text).toContain("  Business details: sample (sample: true; enter the real ones in Admin > Settings).");
    expect(text).toContain(`  Sample notice: on, "${TEST_MODE_NOTICE_TEXT}".`);
    expect(text).toContain(`created ${String(rows.products.length).padStart(3)}`);
    expect(text).toContain("order=10001, license=20001, ticket=1001, lead=1001");
    expect(text).toContain("founder@axiomaticsoftwaresolutions.com");
    expect(text).toContain("https://shop.example.in/sign-in");
    expect(text).toContain("  - w1");
    expect(text).toContain("  - n1");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(rows.products[0]?.tagline);
  });

  it("says when nothing was written", () => {
    const dry = formatBootstrapReport({ dryRun: true, changed: false, plan });
    expect(dry).toMatch(/^Production bootstrap - DRY RUN: nothing was written/);
    expect(dry).toContain("would create");
    expect(dry).toContain("  Business details: would be sample");
    expect(dry).not.toContain("Next steps");
    const noop = formatBootstrapReport({ dryRun: false, changed: false, plan: { ...plan, catalog: "skip", bootstrappedAt: new Date("2026-10-07T06:00:00Z") } });
    expect(noop).toMatch(/^Production bootstrap - nothing to do/);
    expect(noop).toContain("skipped (bootstrapped on 7 Oct 2026)");
  });
});

describe("formatBootstrapReport with --update-catalog", () => {
  const none = { create: [], update: [], kept: 0 };
  const plan: BootstrapPlan = {
    bootstrappedAt: new Date("2026-10-07T06:00:00Z"),
    catalog: "update",
    settings: { create: [], kept: 5 },
    categories: { ...none, kept: rows.categories.length },
    products: { ...none, kept: rows.products.length },
    plans: { ...none, kept: rows.plans.length },
    releases: { create: [], kept: rows.releases.length },
    faqs: { ...none, kept: rows.faqs.length },
    templates: { ...none, kept: rows.templates.length },
    counters: { create: [], kept: [...rows.counters] },
    owner: { action: "none", email: "founder@axiomaticsoftwaresolutions.com" },
    notices: [],
  };

  it("says what a refresh would do, what it did, or that the catalog already matches the code", () => {
    expect(formatBootstrapReport({ dryRun: true, changed: false, plan })).toContain("Catalog and content: would be re-applied from code");
    expect(formatBootstrapReport({ dryRun: false, changed: false, plan })).toContain("Catalog and content: already match the code");
    const changed: BootstrapPlan = { ...plan, plans: { create: [], update: [{ id: "x", data: { pricePaise: 1 } }], kept: rows.plans.length - 1 } };
    const text = formatBootstrapReport({ dryRun: false, changed: true, plan: changed });
    expect(text).toContain("Catalog and content: re-applied from code");
    expect(text).toMatch(/plans\s+created\s+0\s+updated\s+1\s+kept/);
    expect(text).not.toContain("Next steps");
  });
});
