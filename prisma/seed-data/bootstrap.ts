/**
 * Production bootstrap (scripts/bootstrap-production.ts): what an EMPTY production database needs, and nothing else.
 *
 * The dev seed (prisma/seed.ts) refuses production and writes SAMPLE customers, orders, licenses and tickets. This
 * module reuses the seed's catalog and content modules (./catalog, ./content) and writes only:
 * - catalog: categories (with blurbs), PUBLISHED products, plans, and one DRAFT release per product (the newest sample
 *   version, notes only, no files). Admin > Releases publishes a release only once it has an installer, so drafts are
 *   the honest state until the owner uploads one;
 * - FAQs (home, pricing, support, per product) and the notification templates;
 * - site settings: business details from BOOTSTRAP_* (else the SAMPLE placeholders), always `sample: true` unless
 *   BOOTSTRAP_BUSINESS_SAMPLE=false; tax and licensing defaults; banner off; the sample notice on (test release), in
 *   test-mode wording while PAYMENT_KEY_ID is a Razorpay test key (BOOTSTRAP_SAMPLE_NOTICE_TEXT overrides the text);
 * - counters: AX-10001, LIC-20001, T-1001, DEMO-/MSG-1001. Invoice and credit-note series are not written: they
 *   start at 0001 in each financial year (lib/counters.ts COUNTER_START);
 * - the first Owner (argon2id, ACTIVE, email verified, two-step sign-in OFF: password only until the Owner turns it on
 *   in Admin > My profile once email sending works; decisions.md 2026-10-08) from BOOTSTRAP_OWNER_*.
 * Never: customers, business accounts, orders, payments, licenses, tickets, coupons, leads or sample staff.
 *
 * Idempotent: one transaction under an advisory lock; rows are only created when missing; the catalog step runs once
 * (an AuditLog row with targetType "system" and targetId "bootstrap" records every run that changed something).
 * `updateCatalog` re-applies catalog and content copy from code but keeps admin-owned switches (product status, plan
 * archived, FAQ visibility and order, template active flag) and only adds releases to products that have none.
 * Settings, counters and existing users are never modified. A second Owner is never created.
 *
 * Pure: readBootstrapConfig(), buildBootstrapRows(), formatBootstrapReport(). Database: planBootstrap() (reads only),
 * applyBootstrap() (writes a plan), runBootstrap() (both, or only the plan in a READ ONLY transaction for dry runs).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PublishStatus, ReleaseStatus, StaffRole, StaffStatus, UserKind } from "@/generated/prisma/enums";
import { hashPassword } from "@/lib/auth/password";
import { SETTING_DEFAULTS, SETTING_KEYS, settingSchemas, type BusinessSettings, type SampleNoticeSettings, type SettingKey, type SiteSettings } from "@/lib/config";
import type { Db, Tx } from "@/lib/db";
import { formatDateIST, startOfDayIST } from "@/lib/dates";
import { isPlaceholder } from "@/lib/env";
import { STABLE_CHANNEL, compareVersions } from "@/lib/licensing/entitlement";
import { NAME_MAX } from "@/lib/validation/auth";
import { makeEmailSchema } from "@/lib/validation/contact";
import { NAME_LINK_ERROR, isLinkLikeName } from "@/lib/validation/names";
import { PASSWORD_ERROR, isAcceptablePassword } from "@/lib/validation/password";
import { CATEGORIES, PLANS, PRODUCTS, planSortOrder, productContentSchema, type SeedFaq, type SeedProduct, type SeedRelease } from "./catalog";
import { HOME_FAQS, NOTIFICATION_TEMPLATES, PRICING_FAQS, SAMPLE_NOTICE_TEXT, SEED_SETTINGS, SUPPORT_FAQS, templateBody } from "./content";
import { seedIds } from "./ids";
import type { WithId } from "./types";

const NL = "\n";

/** A refusal or invalid input. Messages name variables and rules, never their values (passwords included). */
export class BootstrapError extends Error {
  override name = "BootstrapError";
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(problems.length === 1 ? (problems[0] ?? "") : [`${problems.length} problems:`, ...problems.map((p) => `  - ${p}`)].join(NL));
    this.problems = problems;
  }
}

// ---------- Environment ----------

export const OWNER_ENV = {
  email: "BOOTSTRAP_OWNER_EMAIL",
  password: "BOOTSTRAP_OWNER_PASSWORD",
  name: "BOOTSTRAP_OWNER_NAME",
} as const;
export const DEFAULT_OWNER_NAME = "Owner";

type BusinessField = Exclude<keyof BusinessSettings, "sample">;

/** One variable per business setting; unset ones keep the SAMPLE placeholder (prisma/seed-data/content.ts). */
export const BUSINESS_ENV: Readonly<Record<BusinessField, string>> = {
  legalName: "BOOTSTRAP_BUSINESS_LEGAL_NAME",
  gstin: "BOOTSTRAP_BUSINESS_GSTIN",
  address: "BOOTSTRAP_BUSINESS_ADDRESS",
  city: "BOOTSTRAP_BUSINESS_CITY",
  state: "BOOTSTRAP_BUSINESS_STATE",
  pin: "BOOTSTRAP_BUSINESS_PIN",
  supportEmail: "BOOTSTRAP_SUPPORT_EMAIL",
  salesEmail: "BOOTSTRAP_SALES_EMAIL",
  legalEmail: "BOOTSTRAP_LEGAL_EMAIL",
  privacyEmail: "BOOTSTRAP_PRIVACY_EMAIL",
  phone: "BOOTSTRAP_BUSINESS_PHONE",
  hours: "BOOTSTRAP_BUSINESS_HOURS",
};
/** "false" marks the business details real (invoices become tax invoices); unset or "true" keeps `sample: true`. */
export const BUSINESS_SAMPLE_ENV = "BOOTSTRAP_BUSINESS_SAMPLE";
export const SAMPLE_NOTICE_ENV = "BOOTSTRAP_SAMPLE_NOTICE_TEXT";
/**
 * Default sample notice (the strip on every storefront page) while payments run in test mode. With live keys the dev
 * seed's prototype wording is used instead, because "no real money is charged" would then be untrue.
 */
export const TEST_MODE_NOTICE_TEXT =
  "Test site \u00B7 Payments run in test mode, so no real money is charged. Products, prices and policies are sample content.";

/** The seller identity printed on tax invoices; all six must be real before `sample` may be false. */
export const SELLER_IDENTITY_FIELDS: readonly BusinessField[] = ["legalName", "gstin", "address", "city", "state", "pin"];
const BUSINESS_EMAIL_FIELDS: readonly BusinessField[] = ["supportEmail", "salesEmail", "legalEmail", "privacyEmail"];

export type BootstrapOwnerInput = { email: string; name: string; password: string };

export type BootstrapConfig = {
  owner: BootstrapOwnerInput | null;
  business: BusinessSettings;
  /** Business fields that came from BOOTSTRAP_* variables. */
  businessSupplied: BusinessField[];
  sampleNotice: SampleNoticeSettings;
  /** About the business values above (placeholder addresses that never receive mail); only relevant while the
   * business setting is being created. Safe to print. */
  warnings: string[];
};

type Source = Record<string, string | undefined>;

/** Trimmed value without surrounding quotes (some env files keep them), or undefined when empty. Not for passwords. */
function readValue(source: Source, key: string): string | undefined {
  let v = source[key]?.trim();
  if (!v) return undefined;
  const first = v.charAt(0);
  if (v.length >= 2 && (first === '"' || first === "'") && v.endsWith(first)) v = v.slice(1, -1).trim();
  return v === "" ? undefined : v;
}

/**
 * True for domains reserved for documentation and testing (RFC 2606 / RFC 6761) and mDNS names: mail sent there
 * never arrives, so an Owner with such an address could never receive a password reset (or, once two-step is on, the
 * emailed sign-in code).
 */
export function isUndeliverableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const labels = domain.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (["example", "test", "invalid", "localhost", "local"].includes(tld)) return true;
  return labels.length >= 2 && labels[labels.length - 2] === "example" && ["com", "net", "org"].includes(tld);
}

function parseFlag(value: string): boolean | null {
  const v = value.toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  return null;
}

function readOwner(source: Source, problems: string[]): BootstrapOwnerInput | null {
  const rawEmail = readValue(source, OWNER_ENV.email);
  // Passwords are used exactly as given (never trimmed or unquoted), like every password in the app.
  const password = source[OWNER_ENV.password];
  const rawName = readValue(source, OWNER_ENV.name);
  const hasPassword = password !== undefined && password !== "";
  if (rawEmail === undefined && !hasPassword && rawName === undefined) return null;

  const start = problems.length;
  if (rawEmail === undefined) problems.push(`${OWNER_ENV.email}: is required when ${OWNER_ENV.password} or ${OWNER_ENV.name} is set`);
  if (!hasPassword) problems.push(`${OWNER_ENV.password}: is required with ${OWNER_ENV.email}`);

  let email = "";
  if (rawEmail !== undefined) {
    const parsed = makeEmailSchema().safeParse(rawEmail);
    if (!parsed.success) problems.push(`${OWNER_ENV.email}: is not a valid email address`);
    else if (isUndeliverableEmail(parsed.data)) {
      problems.push(
        `${OWNER_ENV.email}: must be a mailbox you can read. Password resets (and sign-in codes, once two-step is on) go to this address, and reserved domains such as .example never receive mail`,
      );
    } else email = parsed.data;
  }
  if (hasPassword) {
    if (isPlaceholder(password)) problems.push(`${OWNER_ENV.password}: is a placeholder value; choose a real password`);
    else if (!isAcceptablePassword(password)) problems.push(`${OWNER_ENV.password}: ${PASSWORD_ERROR}`);
  }
  const name = rawName ?? DEFAULT_OWNER_NAME;
  if (Array.from(name).length > NAME_MAX) problems.push(`${OWNER_ENV.name}: use ${NAME_MAX} characters or fewer`);
  else if (isLinkLikeName(name)) problems.push(`${OWNER_ENV.name}: ${NAME_LINK_ERROR}`);

  return problems.length > start ? null : { email, name, password: password ?? "" };
}

function readBusiness(source: Source, problems: string[], warnings: string[]): { business: BusinessSettings; supplied: BusinessField[] } {
  const merged: Record<string, unknown> = { ...SEED_SETTINGS.business };
  const supplied: BusinessField[] = [];
  for (const field of Object.keys(BUSINESS_ENV) as BusinessField[]) {
    const value = readValue(source, BUSINESS_ENV[field]);
    if (value === undefined) continue;
    merged[field] = value;
    supplied.push(field);
  }

  let sample = true;
  const rawSample = readValue(source, BUSINESS_SAMPLE_ENV);
  if (rawSample !== undefined) {
    const flag = parseFlag(rawSample);
    if (flag === null) problems.push(`${BUSINESS_SAMPLE_ENV}: must be true or false`);
    else sample = flag;
  }
  if (!sample) {
    const missing = SELLER_IDENTITY_FIELDS.filter((f) => !supplied.includes(f));
    if (missing.length > 0) {
      problems.push(`${BUSINESS_SAMPLE_ENV}: false needs the real seller details; also set ${missing.map((f) => BUSINESS_ENV[f]).join(", ")}`);
    }
  }
  merged.sample = sample;

  const parsed = settingSchemas.business.safeParse(merged);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = String(issue.path[0] ?? "");
      const field = path in BUSINESS_ENV ? (path as BusinessField) : null;
      const key = field ? BUSINESS_ENV[field] : "BOOTSTRAP_BUSINESS_*";
      if (seen.has(key)) continue;
      seen.add(key);
      const hint = field && !supplied.includes(field) ? " (this is still the sample placeholder; set it too)" : "";
      problems.push(`${key}: ${issue.message}${hint}`);
    }
    return { business: { ...SEED_SETTINGS.business }, supplied };
  }

  for (const field of BUSINESS_EMAIL_FIELDS) {
    const value = String(parsed.data[field]);
    if (isUndeliverableEmail(value)) {
      warnings.push(`business ${field} is ${value}, which never receives mail; set ${BUSINESS_ENV[field]} or edit Admin > Settings > Business`);
    }
  }
  return { business: parsed.data, supplied };
}

/**
 * Whether the env file EXPLICITLY puts payments in test mode: PAYMENT_PROVIDER=mock, or razorpay with a Key ID starting
 * with "rzp_test". Unset is not test mode: production keeps payments in Admin > Settings > Integrations (saved after
 * this bootstrap, possibly with live keys), so the neutral sample notice is used and never claims that no real money
 * is charged. Like the admin TEST badge (lib/admin/context.ts), "not configured" means no test-mode wording.
 */
export function isPaymentTestMode(source: Source): boolean {
  const provider = readValue(source, "PAYMENT_PROVIDER");
  if (provider === "mock") return true;
  return provider === "razorpay" && (readValue(source, "PAYMENT_KEY_ID") ?? "").startsWith("rzp_test");
}

function readSampleNotice(source: Source, problems: string[]): SampleNoticeSettings {
  const text = readValue(source, SAMPLE_NOTICE_ENV) ?? (isPaymentTestMode(source) ? TEST_MODE_NOTICE_TEXT : SAMPLE_NOTICE_TEXT);
  const parsed = settingSchemas["content.sampleNotice"].safeParse({ enabled: true, text });
  if (parsed.success) return parsed.data;
  problems.push(`${SAMPLE_NOTICE_ENV}: use 200 characters or fewer`);
  return { enabled: true, text: SAMPLE_NOTICE_TEXT };
}

/** Reads and validates every BOOTSTRAP_* variable. Throws BootstrapError listing all problems (never values). */
export function readBootstrapConfig(source: Source = process.env): BootstrapConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const owner = readOwner(source, problems);
  const { business, supplied } = readBusiness(source, problems, warnings);
  const sampleNotice = readSampleNotice(source, problems);
  if (problems.length > 0) throw new BootstrapError(problems);
  return { owner, business, businessSupplied: supplied, sampleNotice, warnings };
}

// ---------- Environment files ----------

/** One file read by @next/env loadEnvConfig() (its `loadedEnvFiles`), in the order it read them. */
export type EnvFile = { path: string; contents: string };

/** Text after `KEY=` on the last line that assigns KEY (dotenv: a later line wins), or undefined. */
function rawAssignment(contents: string, key: string): string | undefined {
  let raw: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    let body = line.trimStart();
    if (body.startsWith("export ")) body = body.slice("export ".length).trimStart();
    if (!body.startsWith(key)) continue;
    const rest = body.slice(key.length).trimStart();
    if (rest.startsWith("=")) raw = rest.slice(1);
  }
  return raw;
}

/**
 * Where BOOTSTRAP_OWNER_PASSWORD came from, and whether reading the .env file changed it. @next/env expands `$NAME`
 * (even inside single quotes), reads an unquoted `#` as the start of a comment and trims spaces, so `Pa$$word#1` in
 * .env.production silently becomes a different password. A value already in the process environment is used exactly
 * as given (env files never override it). `files` are in @next/env's order, where the first file that sets a key wins.
 * The problem text names the variable and the file, never the value.
 */
export function ownerPasswordSource(
  files: readonly EnvFile[],
  inProcessEnv: boolean,
  loaded: string | undefined,
): { file: string | null; problem: string | null } {
  if (inProcessEnv) return { file: null, problem: null };
  for (const file of files) {
    const raw = rawAssignment(file.contents, OWNER_ENV.password);
    if (raw === undefined) continue;
    let text = raw.trim();
    const quote = text.charAt(0);
    if (text.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) text = text.slice(1, -1);
    if (text === (loaded ?? "")) return { file: file.path, problem: null };
    return {
      file: file.path,
      problem:
        `${OWNER_ENV.password}: reading ${file.path} changes this password ($ starts a variable, # a comment, and spaces and quotes are removed). ` +
        "Remove it from the file and export it in the shell for this one run instead, or choose a password without $, #, quotes, backslashes or surrounding spaces",
    };
  }
  return { file: null, problem: null };
}

// ---------- Rows ----------

export type BootstrapCounter = { key: string; next: number };

/**
 * Production starts fresh, with round numbers that look nothing like each other: orders AX-10001, licenses LIC-20001,
 * tickets T-1001, leads DEMO-1001 / MSG-1001 (lib/leads.ts LEAD_COUNTER_KEY / LEAD_COUNTER_START; not imported here
 * because lib/leads pulls in the email module). `next` is the value the app hands out first. Invoice ("invoice:<FY>")
 * and credit note ("creditnote:<FY>") series are left to the app: each financial year starts at 0001, as GST expects.
 * Counters only ever move forward: the bootstrap creates missing ones and never changes a stored value.
 */
export const BOOTSTRAP_COUNTERS: readonly BootstrapCounter[] = [
  { key: "order", next: 10001 },
  { key: "license", next: 20001 },
  { key: "ticket", next: 1001 },
  { key: "lead", next: 1001 },
];

export type CategoryRow = WithId<Prisma.CategoryCreateManyInput>;
export type ProductRow = WithId<Prisma.ProductCreateManyInput>;
export type PlanRow = WithId<Prisma.PlanCreateManyInput>;
export type ReleaseRow = WithId<Prisma.ReleaseCreateManyInput>;
export type FaqRow = WithId<Prisma.FaqCreateManyInput>;
export type TemplateRow = WithId<Prisma.NotificationTemplateCreateManyInput>;
export type SettingRow = { key: SettingKey; value: Prisma.InputJsonValue };

export type BootstrapRows = {
  settings: SettingRow[];
  categories: CategoryRow[];
  products: ProductRow[];
  plans: PlanRow[];
  releases: ReleaseRow[];
  faqs: FaqRow[];
  templates: TemplateRow[];
  counters: BootstrapCounter[];
};

/** The highest sample version of a product (semver precedence, lib/licensing/entitlement.ts). */
export function newestSeedRelease(product: Pick<SeedProduct, "releases">): SeedRelease | null {
  return [...product.releases].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

function settingRows(input: Pick<BootstrapConfig, "business" | "sampleNotice">): SettingRow[] {
  const values: SiteSettings = {
    business: input.business,
    tax: SEED_SETTINGS.tax,
    licensing: SEED_SETTINGS.licensing,
    // The dev seed's banner text advertises a sample coupon that production does not have.
    "content.banner": SETTING_DEFAULTS["content.banner"],
    "content.sampleNotice": input.sampleNotice,
  };
  // Strict admin-write schemas: the bootstrap can never store a value Admin > Settings would reject.
  return SETTING_KEYS.map((key) => ({ key, value: settingSchemas[key].parse(values[key]) as Prisma.InputJsonValue }));
}

/** Same rows as the dev seed's catalog (tests/unit/bootstrap-production.test.ts compares them), minus the samples. */
function catalogRows(): Pick<BootstrapRows, "categories" | "products" | "plans" | "releases"> {
  const categories = CATEGORIES.map((c, i) => ({ id: c.id, name: c.name, blurb: c.blurb, tone: c.tone, icon: c.icon, sortOrder: i }));
  const products = PRODUCTS.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    summary: p.summary,
    icon: p.icon,
    tone: p.tone,
    categoryId: p.categoryId,
    platforms: [...p.platforms],
    status: PublishStatus.PUBLISHED,
    demoEnabled: p.demoEnabled,
    rank: p.rank,
    content: productContentSchema.parse(p.content),
    relatedIds: [...p.relatedIds],
    createdAt: startOfDayIST(p.added),
  }));
  const plans = PLANS.map((p) => ({
    id: p.id,
    productId: p.productId,
    type: p.type,
    name: p.name,
    summary: p.summary,
    includes: [...p.includes],
    pricePaise: p.pricePaise,
    interval: p.interval,
    trialDays: p.trialDays,
    deviceLimit: p.deviceLimit,
    perUnit: p.perUnit,
    maxQty: p.maxQty,
    multiDevice: p.multiDevice,
    updatesMonths: p.updatesMonths,
    popular: p.popular,
    archived: false,
    sortOrder: planSortOrder(p.id),
  }));
  // Draft releases carry the version and notes only; releasedAt is set when Admin > Releases publishes them.
  const releases = PRODUCTS.flatMap((p): ReleaseRow[] => {
    const r = newestSeedRelease(p);
    if (!r) return [];
    return [{ id: seedIds.release(p.id, r.version), productId: p.id, version: r.version, channel: STABLE_CHANNEL, status: ReleaseStatus.DRAFT, releasedAt: null, notes: [...r.notes] }];
  });
  return { categories, products, plans, releases };
}

function contentRows(): Pick<BootstrapRows, "faqs" | "templates"> {
  const faqSet = (page: string, list: readonly SeedFaq[]): FaqRow[] =>
    list.map((f, i) => ({ id: seedIds.faq(page, i + 1), page, question: f.question, answer: f.answer, href: f.href ?? null, published: true, sortOrder: i }));
  const faqs = [
    ...faqSet("home", HOME_FAQS),
    ...faqSet("pricing", PRICING_FAQS),
    ...faqSet("support", SUPPORT_FAQS),
    ...PRODUCTS.flatMap((p) => faqSet(p.id, p.faqs)),
  ];
  const templates = NOTIFICATION_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    channel: "email",
    subject: t.subject,
    body: t.body ?? templateBody(t.subject),
    active: t.active,
  }));
  return { faqs, templates };
}

/** Every row the bootstrap may write. Pure and deterministic (no clock, no env, no secrets). */
export function buildBootstrapRows(input: Pick<BootstrapConfig, "business" | "sampleNotice">): BootstrapRows {
  return {
    settings: settingRows(input),
    ...catalogRows(),
    ...contentRows(),
    counters: BOOTSTRAP_COUNTERS.map((c) => ({ ...c })),
  };
}

// ---------- Plan (reads only) ----------

/** AuditLog row written by every bootstrap run that changed something; the first one marks the catalog as done. */
export const BOOTSTRAP_AUDIT = { targetType: "system", targetId: "bootstrap", target: "Production bootstrap" } as const;
/** pg_advisory_xact_lock key ("AXSB"): a second bootstrap waits for the first instead of racing it. */
export const BOOTSTRAP_LOCK_KEY = 1096307522;
export const BOOTSTRAP_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * Fields --update-catalog re-applies from code. Left out on purpose: ids, Product.code (immutable once licenses exist),
 * Plan.productId / type, and the switches admins own: Product.status, Plan.archived, Faq.published / sortOrder / page,
 * NotificationTemplate.active / channel. Releases are never updated (versions, notes and files belong to Admin).
 */
export const UPDATE_FIELDS = {
  categories: ["name", "blurb", "tone", "icon", "sortOrder"],
  products: ["name", "shortName", "tagline", "summary", "icon", "tone", "categoryId", "platforms", "demoEnabled", "rank", "content", "relatedIds"],
  plans: ["name", "summary", "includes", "pricePaise", "interval", "trialDays", "deviceLimit", "perUnit", "maxQty", "multiDevice", "updatesMonths", "popular", "sortOrder"],
  faqs: ["question", "answer", "href"],
  templates: ["name", "subject", "body"],
} as const satisfies {
  categories: readonly (keyof CategoryRow)[];
  products: readonly (keyof ProductRow)[];
  plans: readonly (keyof PlanRow)[];
  faqs: readonly (keyof FaqRow)[];
  templates: readonly (keyof TemplateRow)[];
};

export type RowChanges<R> = { create: R[]; update: { id: string; data: Partial<R> }[]; kept: number };

export type OwnerPlan =
  | { action: "create"; email: string; name: string }
  /** BOOTSTRAP_OWNER_EMAIL is already the Owner: nothing changes (the password is never reset). */
  | { action: "keep"; email: string }
  /** No BOOTSTRAP_OWNER_* given and an Owner exists. */
  | { action: "none"; email: string };

export type BootstrapPlan = {
  /** When an earlier run completed the catalog step (null on the first run). */
  bootstrappedAt: Date | null;
  catalog: "create" | "update" | "skip";
  settings: { create: SettingRow[]; kept: number };
  categories: RowChanges<CategoryRow>;
  products: RowChanges<ProductRow>;
  plans: RowChanges<PlanRow>;
  /** `kept` = products that already have a release of any status (their releases are Admin's). */
  releases: { create: ReleaseRow[]; kept: number };
  faqs: RowChanges<FaqRow>;
  templates: RowChanges<TemplateRow>;
  counters: { create: BootstrapCounter[]; kept: BootstrapCounter[] };
  owner: OwnerPlan;
  notices: string[];
};

export type PlanInput = {
  owner: BootstrapOwnerInput | null;
  updateCatalog: boolean;
  /** Business fields that came from BOOTSTRAP_* (only used for a notice when settings already exist). */
  businessSupplied?: readonly string[];
};

/** Canonical form for comparisons: dates as ISO strings, bigints as strings, object keys sorted (jsonb reorders keys). */
function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, canonical(obj[k])]));
  }
  return value;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Missing rows are created; with `update`, existing rows whose listed fields differ get exactly those fields. */
export function diffRows<R extends { id: string }>(
  rows: readonly R[],
  existing: readonly { id: string }[],
  fields: readonly (keyof R & string)[],
  update: boolean,
): RowChanges<R> {
  const stored = new Map(existing.map((e) => [e.id, e as unknown as Record<string, unknown>]));
  const out: RowChanges<R> = { create: [], update: [], kept: 0 };
  for (const row of rows) {
    const current = stored.get(row.id);
    if (!current) {
      out.create.push(row);
      continue;
    }
    const changed = update ? fields.filter((f) => !sameValue(current[f], row[f])) : [];
    if (changed.length === 0) out.kept += 1;
    else out.update.push({ id: row.id, data: Object.fromEntries(changed.map((f) => [f, row[f]])) as Partial<R> });
  }
  return out;
}

const noChanges = <R>(): RowChanges<R> => ({ create: [], update: [], kept: 0 });
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

/** Refuses databases that went through the dev seed: its sample customers and orders must never reach production. */
async function assertNoDevSeedData(db: Db): Promise<void> {
  const users = await db.user.count({ where: { id: { startsWith: seedIds.user("") } } });
  const accounts = await db.businessAccount.count({ where: { id: { startsWith: seedIds.account("") } } });
  if (users + accounts === 0) return;
  throw new BootstrapError([
    `This database holds development seed data (${users} sample users, ${accounts} sample business accounts). ` +
      "Production must start from an empty database: create a new database, run `prisma migrate deploy`, then run this bootstrap again.",
  ]);
}

async function planOwner(db: Db, input: BootstrapOwnerInput | null): Promise<OwnerPlan> {
  const owners = await db.user.findMany({
    where: { kind: UserKind.STAFF, staffRole: StaffRole.OWNER },
    select: { email: true },
    orderBy: { createdAt: "asc" },
  });
  const first = owners[0];
  if (!input) {
    if (first) return { action: "none", email: first.email };
    throw new BootstrapError([
      `No Owner exists yet: set ${OWNER_ENV.email} and ${OWNER_ENV.password} (and optionally ${OWNER_ENV.name}) for the first run.`,
    ]);
  }
  if (owners.some((o) => o.email === input.email)) return { action: "keep", email: input.email };
  if (first) {
    throw new BootstrapError([
      `An Owner already exists (${first.email}), and the bootstrap never creates a second one. ` +
        "Sign in as that Owner and invite people from Admin > Staff (an Owner can change a staff member's role later), " +
        `or unset ${OWNER_ENV.email}, ${OWNER_ENV.password} and ${OWNER_ENV.name} to run the other steps.`,
    ]);
  }
  const taken = await db.user.findUnique({ where: { email: input.email }, select: { kind: true } });
  if (taken) {
    throw new BootstrapError([
      `${OWNER_ENV.email}: this address already belongs to a ${taken.kind === UserKind.STAFF ? "staff" : "customer"} account. ` +
        "Use another address for the Owner (the bootstrap never converts an existing user).",
    ]);
  }
  return { action: "create", email: input.email, name: input.name };
}

/**
 * Reads the database and decides every change; writes nothing. Throws BootstrapError for refusals (dev seed data, a
 * second Owner, an Owner email in use, a product code taken by another product, no Owner at all).
 * Inside runBootstrap() it runs after the advisory lock, in the same transaction as applyBootstrap().
 */
export async function planBootstrap(db: Db, rows: BootstrapRows, input: PlanInput): Promise<BootstrapPlan> {
  // Sequential on purpose: inside an interactive transaction pg runs one query at a time anyway.
  await assertNoDevSeedData(db);
  const owner = await planOwner(db, input.owner);
  const marker = await db.auditLog.findFirst({
    where: { targetType: BOOTSTRAP_AUDIT.targetType, targetId: BOOTSTRAP_AUDIT.targetId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const catalog = input.updateCatalog ? "update" : marker ? "skip" : "create";
  const notices: string[] = [];

  const storedSettings = await db.siteSetting.findMany({ where: { key: { in: rows.settings.map((s) => s.key) } }, select: { key: true } });
  const storedKeys = new Set(storedSettings.map((s) => s.key));
  const settings = { create: rows.settings.filter((s) => !storedKeys.has(s.key)), kept: storedKeys.size };
  if ((input.businessSupplied?.length ?? 0) > 0 && storedKeys.has("business")) {
    notices.push("Business settings already exist, so BOOTSTRAP_BUSINESS_* values were not applied: edit them in Admin > Settings.");
  }

  const storedCounters = await db.counter.findMany({ where: { key: { in: rows.counters.map((c) => c.key) } } });
  const counterKeys = new Set(storedCounters.map((c) => c.key));
  const counters = {
    create: rows.counters.filter((c) => !counterKeys.has(c.key)),
    kept: storedCounters.map((c) => ({ key: c.key, next: c.next })).sort((a, b) => a.key.localeCompare(b.key)),
  };

  const plan: BootstrapPlan = {
    bootstrappedAt: marker?.createdAt ?? null,
    catalog,
    settings,
    categories: noChanges(),
    products: noChanges(),
    plans: noChanges(),
    releases: { create: [], kept: 0 },
    faqs: noChanges(),
    templates: noChanges(),
    counters,
    owner,
    notices,
  };
  if (catalog === "skip") return plan;

  const update = catalog === "update";
  const codes = await db.product.findMany({ where: { code: { in: rows.products.map((p) => p.code) } }, select: { id: true, code: true } });
  const clash = codes.find((c) => rows.products.some((p) => p.code === c.code && p.id !== c.id));
  if (clash) {
    throw new BootstrapError([
      `Product code ${clash.code} already belongs to product "${clash.id}", which the bootstrap did not create. Rename one of them before running it.`,
    ]);
  }
  plan.categories = diffRows(rows.categories, await db.category.findMany({ where: { id: { in: ids(rows.categories) } } }), UPDATE_FIELDS.categories, update);
  plan.products = diffRows(rows.products, await db.product.findMany({ where: { id: { in: ids(rows.products) } } }), UPDATE_FIELDS.products, update);
  plan.plans = diffRows(rows.plans, await db.plan.findMany({ where: { id: { in: ids(rows.plans) } } }), UPDATE_FIELDS.plans, update);
  plan.faqs = diffRows(rows.faqs, await db.faq.findMany({ where: { id: { in: ids(rows.faqs) } } }), UPDATE_FIELDS.faqs, update);
  plan.templates = diffRows(rows.templates, await db.notificationTemplate.findMany({ where: { id: { in: ids(rows.templates) } } }), UPDATE_FIELDS.templates, update);

  const withReleases = await db.release.findMany({
    where: { productId: { in: rows.releases.map((r) => r.productId) } },
    select: { productId: true },
    distinct: ["productId"],
  });
  const released = new Set(withReleases.map((r) => r.productId));
  plan.releases = { create: rows.releases.filter((r) => !released.has(r.productId)), kept: released.size };
  return plan;
}

// ---------- Apply ----------

export type CountLine = { label: string; create: number; update: number; kept: number };

/** Per-table counts of a plan, in write order. Counts only: never row contents. */
export function planCounts(plan: BootstrapPlan): CountLine[] {
  const line = (label: string, c: { create: unknown[]; update?: unknown[]; kept: number }) => ({
    label,
    create: c.create.length,
    update: c.update?.length ?? 0,
    kept: c.kept,
  });
  return [
    line("site settings", plan.settings),
    line("categories", plan.categories),
    line("products", plan.products),
    line("plans", plan.plans),
    line("releases (draft)", plan.releases),
    line("faqs", plan.faqs),
    line("notification templates", plan.templates),
    line("counters", { create: plan.counters.create, kept: plan.counters.kept.length }),
    line("owner", { create: plan.owner.action === "create" ? [plan.owner] : [], kept: plan.owner.action === "create" ? 0 : 1 }),
  ];
}

export function planChangesSomething(plan: BootstrapPlan): boolean {
  return planCounts(plan).some((c) => c.create + c.update > 0);
}

function auditDetail(plan: BootstrapPlan): string {
  const counts = planCounts(plan).filter((c) => c.label !== "owner");
  const created = counts.filter((c) => c.create > 0).map((c) => `${c.label} ${c.create}`);
  const updated = counts.filter((c) => c.update > 0).map((c) => `${c.label} ${c.update}`);
  return [
    created.length > 0 ? `Created: ${created.join(", ")}.` : null,
    updated.length > 0 ? `Updated from code: ${updated.join(", ")}.` : null,
    plan.owner.action === "create" ? "Created the Owner account." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

async function applyRows<R extends { id: string }>(
  changes: RowChanges<R>,
  createMany: (data: R[]) => Promise<unknown>,
  update: (id: string, data: Partial<R>) => Promise<unknown>,
): Promise<void> {
  if (changes.create.length > 0) await createMany(changes.create);
  for (const u of changes.update) await update(u.id, u.data);
}

/**
 * Writes a plan inside the caller's transaction, in foreign-key order, plus one AuditLog row (actor "system") when
 * anything changed. `passwordHash` is the argon2id hash of the Owner password (required when the plan creates one).
 */
export async function applyBootstrap(tx: Tx, plan: BootstrapPlan, input: { now: Date; passwordHash: string | null }): Promise<void> {
  if (!planChangesSomething(plan)) return;
  if (plan.settings.create.length > 0) await tx.siteSetting.createMany({ data: plan.settings.create, skipDuplicates: true });
  await applyRows(plan.categories, (data) => tx.category.createMany({ data }), (id, data) => tx.category.update({ where: { id }, data }));
  await applyRows(plan.products, (data) => tx.product.createMany({ data }), (id, data) => tx.product.update({ where: { id }, data }));
  await applyRows(plan.plans, (data) => tx.plan.createMany({ data }), (id, data) => tx.plan.update({ where: { id }, data }));
  if (plan.releases.create.length > 0) await tx.release.createMany({ data: plan.releases.create });
  await applyRows(plan.faqs, (data) => tx.faq.createMany({ data }), (id, data) => tx.faq.update({ where: { id }, data }));
  await applyRows(plan.templates, (data) => tx.notificationTemplate.createMany({ data }), (id, data) => tx.notificationTemplate.update({ where: { id }, data }));
  // ON CONFLICT DO NOTHING: a counter the running app created meanwhile keeps its value (counters never go back).
  if (plan.counters.create.length > 0) await tx.counter.createMany({ data: plan.counters.create, skipDuplicates: true });
  if (plan.owner.action === "create") {
    if (!input.passwordHash) throw new Error("applyBootstrap: the Owner needs a password hash.");
    await tx.user.create({
      data: {
        kind: UserKind.STAFF,
        email: plan.owner.email,
        name: plan.owner.name,
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.now,
        // Off: the site may have no working SMTP yet, and a code that never arrives would lock the Owner out. The Owner
        // turns it on in Admin > My profile once email sending works (decisions.md 2026-10-08).
        twoStepEnabled: false,
        staffRole: StaffRole.OWNER,
        staffStatus: StaffStatus.ACTIVE,
      },
    });
  }
  await tx.auditLog.create({
    data: {
      actorId: null,
      actorRole: "system",
      action: plan.bootstrappedAt === null ? "Bootstrapped production data" : plan.catalog === "update" ? "Refreshed catalog from code" : "Ran production bootstrap",
      target: BOOTSTRAP_AUDIT.target,
      targetType: BOOTSTRAP_AUDIT.targetType,
      targetId: BOOTSTRAP_AUDIT.targetId,
      detail: auditDetail(plan),
      ipPrefix: null,
    },
  });
}

// ---------- Run ----------

export type RunInput = {
  rows: BootstrapRows;
  owner: BootstrapOwnerInput | null;
  businessSupplied?: readonly string[];
  dryRun: boolean;
  updateCatalog: boolean;
  now?: Date;
  /** argon2id by default (lib/auth/password.ts); injectable for tests. */
  hashPassword?: (password: string) => Promise<string>;
};

export type BootstrapReport = { dryRun: boolean; changed: boolean; plan: BootstrapPlan };

/**
 * Plans and applies in ONE transaction, after pg_advisory_xact_lock, so a run either writes everything or nothing and
 * two concurrent runs cannot both create an Owner. A dry run plans inside a READ ONLY transaction: Postgres itself
 * refuses any write, so --dry-run can never change the database.
 */
export async function runBootstrap(db: PrismaClient, input: RunInput): Promise<BootstrapReport> {
  const now = input.now ?? new Date();
  const planInput: PlanInput = { owner: input.owner, updateCatalog: input.updateCatalog, businessSupplied: input.businessSupplied ?? [] };
  if (input.dryRun) {
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return planBootstrap(tx, input.rows, planInput);
    }, BOOTSTRAP_TX_OPTIONS);
    return { dryRun: true, changed: false, plan };
  }
  // Hashed before the transaction so the lock is held briefly. An unused hash (the Owner already exists) is dropped.
  const passwordHash = input.owner ? await (input.hashPassword ?? hashPassword)(input.owner.password) : null;
  const plan = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)::text AS "locked"`;
    const planned = await planBootstrap(tx, input.rows, planInput);
    await applyBootstrap(tx, planned, { now, passwordHash });
    return planned;
  }, BOOTSTRAP_TX_OPTIONS);
  return { dryRun: false, changed: planChangesSomething(plan), plan };
}

// ---------- Report ----------

function counterList(counters: readonly BootstrapCounter[]): string {
  return counters.map((c) => `${c.key}=${c.next}`).join(", ");
}

/**
 * Human summary: counts per table, counters, the Owner's email and what to do next. Never row contents, never the
 * password (the report does not even hold it). `warnings` (BootstrapConfig.warnings) are shown only when this run
 * creates the business setting; `notes` are always shown (e.g. which env file held the Owner password); `appUrl`
 * completes the sign-in link.
 */
export function formatBootstrapReport(
  report: BootstrapReport,
  extra: { warnings?: readonly string[]; notes?: readonly string[]; appUrl?: string } = {},
): string {
  const { plan, dryRun } = report;
  const lines: string[] = [
    dryRun
      ? "Production bootstrap - DRY RUN: nothing was written. Planned changes:"
      : report.changed
        ? "Production bootstrap - done. Changes:"
        : "Production bootstrap - nothing to do: the database already has everything.",
  ];
  if (plan.catalog === "skip") {
    lines.push(`  Catalog and content: skipped (bootstrapped on ${formatDateIST(plan.bootstrappedAt)}); --update-catalog re-applies them from code.`);
  } else if (plan.catalog === "update") {
    const state = dryRun ? "would be re-applied from code" : report.changed ? "re-applied from code" : "already match the code";
    lines.push(`  Catalog and content: ${state} (product status, archived plans, FAQ visibility and order and template on/off are kept).`);
  }
  // A skipped catalog step read nothing, so its tables would only show zeros.
  const catalogLabels = new Set(["categories", "products", "plans", "releases (draft)", "faqs", "notification templates"]);
  const counts = planCounts(plan).filter((c) => plan.catalog !== "skip" || !catalogLabels.has(c.label));
  const width = Math.max(...counts.map((c) => c.label.length));
  const verb = dryRun ? ["would create", "would update"] : ["created", "updated"];
  for (const c of counts) {
    lines.push(`  ${c.label.padEnd(width)}  ${verb[0]} ${String(c.create).padStart(3)}   ${verb[1]} ${String(c.update).padStart(3)}   kept ${String(c.kept).padStart(3)}`);
  }
  if (plan.counters.create.length > 0) lines.push(`  new counters (next number handed out): ${counterList(plan.counters.create)}`);
  if (plan.counters.kept.length > 0) lines.push(`  existing counters (never changed): ${counterList(plan.counters.kept)}`);

  // Settings this run creates (no secrets in them): confirms the business sample flag and the storefront notice.
  const createdSettings = new Map(plan.settings.create.map((s) => [s.key, s.value as Record<string, unknown> | null]));
  const business = createdSettings.get("business");
  if (business) {
    const state = business.sample === false ? "real seller details (sample: false)" : "sample (sample: true; enter the real ones in Admin > Settings)";
    lines.push(`  Business details: ${dryRun ? "would be " : ""}${state}.`);
  }
  const notice = createdSettings.get("content.sampleNotice");
  if (notice) lines.push(`  Sample notice: ${notice.enabled === true ? "on" : "off"}, "${String(notice.text ?? "")}".`);

  const owner = plan.owner;
  if (owner.action === "create") {
    lines.push(`  Owner: ${dryRun ? "would create" : "created"} ${owner.email} ("${owner.name}"), staff Owner, email verified, two-step sign-in off (password only).`);
  } else if (owner.action === "keep") {
    lines.push(`  Owner: ${owner.email} already exists; nothing changed (its password is never reset here: use "Forgot password" on /sign-in).`);
  } else {
    lines.push(`  Owner: ${owner.email} (unchanged).`);
  }

  const createsBusiness = plan.settings.create.some((s) => s.key === "business");
  const notes = [...(createsBusiness ? (extra.warnings ?? []) : []), ...plan.notices, ...(extra.notes ?? [])];
  if (notes.length > 0) lines.push("", "Notes:", ...notes.map((n) => `  - ${n}`));

  // First bootstrap only: later runs (--update-catalog, a missing counter) need no instructions.
  if (!dryRun && report.changed && plan.bootstrappedAt === null) {
    const base = extra.appUrl ?? "";
    lines.push(
      "",
      "Next steps:",
      `  1. Sign in at ${base}/sign-in as the Owner with the password (no emailed code: two-step sign-in starts off).`,
      "     Once email sending works, turn two-step on in Admin > My profile (go-live checklist).",
      "  2. Admin > Releases: each product has a DRAFT release without files. Upload an installer, then publish it.",
      "  3. Admin > Settings: check the business details. While `sample` is on, invoices say they are not valid tax",
      "     invoices and the site shows sample labels; switch it off (and the sample notice in Admin > Content) at go-live.",
    );
  }
  return lines.join(NL);
}
