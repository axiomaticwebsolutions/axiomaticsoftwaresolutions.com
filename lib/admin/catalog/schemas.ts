/**
 * Request bodies of the admin catalog routes (strict: unknown keys are rejected) and the plan rules both the create
 * and the edit paths check. Copy is new (the prototype only edited a few listing and pricing fields); it needs owner
 * review. Pure and client-safe: the admin forms validate with the same schemas.
 */
import { z } from "zod";
import { ICON_PATHS } from "@/components/icons/registry";
import { productContentSchema } from "@/lib/catalog/content";
import type { BillingIntervalKey, PlanTypeKey } from "./types";

// ---------- Vocabulary ----------

export const CATALOG_TONES = ["sage", "peach", "blue", "lavender", "pink"] as const;
export const CATALOG_PLATFORMS = ["windows", "macos", "android"] as const;
export const PLAN_TYPES = ["TRIAL", "ONE_TIME", "ANNUAL", "SUBSCRIPTION", "DEVICE_ADDON", "MAINTENANCE"] as const satisfies readonly PlanTypeKey[];
export const BILLING_INTERVALS = ["MONTH", "YEAR"] as const satisfies readonly BillingIntervalKey[];
export const RELEASE_CHANNELS = ["stable", "beta"] as const;

/** Slugs: product, category and plan ids ("medical-billing", "med-annual"). */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PRODUCT_CODE_RE = /^[A-Z]{3}$/;
/** Semantic version with 2-4 numeric parts (the apps send "4.2" and "4.2.1.1830"), optional pre-release and build. */
export const VERSION_RE = /^(?:0|[1-9][0-9]*)(?:[.](?:0|[1-9][0-9]*)){1,3}(?:-[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/;
/** Per-unit word for quantity-priced plans ("terminal"). */
export const PER_UNIT_RE = /^[a-z]{3,20}$/;

/** Static route segments next to [id] folders: ids may never take these names. */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["export", "bulk-archive", "new", "categories"]);

export const MAX_PRICE_PAISE = 1_000_000_000; // Rs 1 crore
export const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_RELATED = 6;
export const MAX_NOTES = 20;
export const MAX_INCLUDES = 10;

export const CATALOG_ERRORS = {
  slug: "Use lower-case letters, numbers and single hyphens, e.g. medical-billing.",
  reserved: "This id is reserved. Choose another.",
  code: "Use exactly 3 capital letters, e.g. MED.",
  name: "Enter a name.",
  shortName: "Enter a short display name.",
  tagline: "Enter a tagline.",
  summary: "Enter a summary.",
  category: "Choose a category.",
  platforms: "Choose at least one platform.",
  icon: "Choose an icon from the list.",
  tone: "Choose a colour.",
  number: "Enter a whole number.",
  price: "Enter a valid price.",
  version: "Use a version like 4.2.1 (numbers and dots, optional -beta.1).",
  notes: "Write each note in 300 characters or fewer.",
  tooLong: (max: number) => `Use ${max} characters or fewer.`,
  noChanges: "Change at least one field.",
} as const;

const iconNames: ReadonlySet<string> = new Set(Object.keys(ICON_PATHS));

/** A Material Symbols name the app's icon registry has (the storefront can only draw those). */
export function isKnownIcon(name: string): boolean {
  return iconNames.has(name);
}

const text = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, CATALOG_ERRORS.tooLong(max));

const slug = (max = 60) =>
  z
    .string()
    .trim()
    .min(2, CATALOG_ERRORS.slug)
    .max(max, CATALOG_ERRORS.tooLong(max))
    .regex(SLUG_RE, CATALOG_ERRORS.slug)
    .refine((v) => !RESERVED_IDS.has(v), CATALOG_ERRORS.reserved);

const int = (min: number, max: number) =>
  z.int(CATALOG_ERRORS.number).min(min, `Enter ${min} or more.`).max(max, `Enter ${max} or less.`);

const icon = z.string().trim().max(60).refine(isKnownIcon, CATALOG_ERRORS.icon);
const tone = z.enum(CATALOG_TONES, CATALOG_ERRORS.tone);
const platforms = z
  .array(z.enum(CATALOG_PLATFORMS, CATALOG_ERRORS.platforms))
  .min(1, CATALOG_ERRORS.platforms)
  .max(CATALOG_PLATFORMS.length)
  .transform((list) => CATALOG_PLATFORMS.filter((p) => list.includes(p)));
const code = z.string().trim().toUpperCase().regex(PRODUCT_CODE_RE, CATALOG_ERRORS.code);

/** productContentSchema plus a check that every feature icon exists in the registry. */
export const adminProductContentSchema = productContentSchema.superRefine((content, ctx) => {
  content.features.forEach((f, i) => {
    if (!isKnownIcon(f.icon)) ctx.addIssue({ code: "custom", path: ["features", i, "icon"], message: CATALOG_ERRORS.icon });
  });
});

// ---------- Products ----------

const productFields = {
  name: text(3, 120, CATALOG_ERRORS.name),
  shortName: text(2, 60, CATALOG_ERRORS.shortName),
  tagline: text(1, 200, CATALOG_ERRORS.tagline),
  summary: text(1, 600, CATALOG_ERRORS.summary),
  categoryId: z.string().trim().regex(SLUG_RE, CATALOG_ERRORS.category).max(60),
  platforms,
  icon,
  tone: tone.nullable(),
  rank: int(0, 9999),
  demoEnabled: z.boolean(),
};

export const productCreateSchema = z.strictObject({
  id: slug(),
  code,
  ...productFields,
  tone: productFields.tone.default(null),
  rank: productFields.rank.default(100),
  demoEnabled: productFields.demoEnabled.default(true),
});

export const productUpdateSchema = z
  .strictObject({
    code: code.optional(),
    name: productFields.name.optional(),
    shortName: productFields.shortName.optional(),
    tagline: productFields.tagline.optional(),
    summary: productFields.summary.optional(),
    categoryId: productFields.categoryId.optional(),
    platforms: platforms.optional(),
    icon: icon.optional(),
    tone: productFields.tone.optional(),
    rank: productFields.rank.optional(),
    demoEnabled: productFields.demoEnabled.optional(),
    content: adminProductContentSchema.optional(),
    relatedIds: z
      .array(z.string().trim().regex(SLUG_RE).max(60))
      .max(MAX_RELATED, `Choose up to ${MAX_RELATED} related products.`)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), CATALOG_ERRORS.noChanges);

export type ProductCreateInput = z.output<typeof productCreateSchema>;
export type ProductUpdateInput = z.output<typeof productUpdateSchema>;

// ---------- Categories ----------

const categoryFields = {
  name: text(2, 60, CATALOG_ERRORS.name),
  blurb: z.string().trim().max(200, CATALOG_ERRORS.tooLong(200)).nullable(),
  tone,
  icon,
  sortOrder: int(0, 9999),
};

export const categoryCreateSchema = z.strictObject({
  id: slug(40),
  ...categoryFields,
  blurb: categoryFields.blurb.default(null),
  sortOrder: categoryFields.sortOrder.default(0),
});

export const categoryUpdateSchema = z
  .strictObject({
    name: categoryFields.name.optional(),
    blurb: categoryFields.blurb.optional(),
    tone: categoryFields.tone.optional(),
    icon: categoryFields.icon.optional(),
    sortOrder: categoryFields.sortOrder.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), CATALOG_ERRORS.noChanges);

export type CategoryCreateInput = z.output<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.output<typeof categoryUpdateSchema>;

// ---------- Plans ----------

/** The fields the plan rules look at (a stored plan, or a stored plan with an edit applied). */
export type PlanRuleInput = {
  type: PlanTypeKey;
  pricePaise: number;
  interval: BillingIntervalKey | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
};

export type PlanRuleIssue = { path: keyof PlanRuleInput; message: string };

export const PLAN_RULE_MESSAGES = {
  trialPrice: "Trials are free. Set the price to 0.",
  paidPrice: "Enter a price above zero. Free plans are trials.",
  trialDays: "Enter the trial length in days.",
  deviceLimit: "Enter how many computers the license covers.",
  noDeviceLimit: "Add-ons and maintenance attach to an existing license, so leave the device limit empty.",
  intervalYear: "This plan type renews yearly.",
  intervalNeeded: "Choose monthly or yearly.",
  noInterval: "This plan type has no billing period.",
  noTrialDays: "Only trials have a trial length.",
  updatesMonths: "Enter how many months of updates are included.",
  noUpdatesMonths: "Updates last for the term of this plan type, so leave this empty.",
  perUnitType: "Only one-time, annual and subscription plans can be priced per unit.",
  maxQty: "Enter the most units one purchase can have.",
  maxQtyType: "A quantity limit applies to per-unit plans and device add-ons only.",
  multiDevice: "Multi-device plans cover more than one computer.",
} as const;

/**
 * What a plan of `type` must and must not set (lib/licensing/terms.ts and lib/pricing.ts read these fields):
 * trials are free with a length in days; one-time plans carry months of updates; annual and maintenance plans renew
 * yearly; subscriptions monthly or yearly; add-ons and maintenance attach to an existing license (no device limit).
 */
export function planRuleIssues(plan: PlanRuleInput): PlanRuleIssue[] {
  const issues: PlanRuleIssue[] = [];
  const add = (path: keyof PlanRuleInput, message: string) => issues.push({ path, message });
  const attaches = plan.type === "DEVICE_ADDON" || plan.type === "MAINTENANCE";
  const unitPriced = plan.type === "ONE_TIME" || plan.type === "ANNUAL" || plan.type === "SUBSCRIPTION";

  if (plan.type === "TRIAL") {
    if (plan.pricePaise !== 0) add("pricePaise", PLAN_RULE_MESSAGES.trialPrice);
    if (plan.trialDays === null) add("trialDays", PLAN_RULE_MESSAGES.trialDays);
  } else {
    if (plan.pricePaise <= 0) add("pricePaise", PLAN_RULE_MESSAGES.paidPrice);
    if (plan.trialDays !== null) add("trialDays", PLAN_RULE_MESSAGES.noTrialDays);
  }

  if (plan.type === "ANNUAL" || plan.type === "MAINTENANCE") {
    if (plan.interval !== "YEAR") add("interval", PLAN_RULE_MESSAGES.intervalYear);
  } else if (plan.type === "SUBSCRIPTION") {
    if (plan.interval === null) add("interval", PLAN_RULE_MESSAGES.intervalNeeded);
  } else if (plan.interval !== null) {
    add("interval", PLAN_RULE_MESSAGES.noInterval);
  }

  if (attaches) {
    if (plan.deviceLimit !== null) add("deviceLimit", PLAN_RULE_MESSAGES.noDeviceLimit);
  } else if (plan.deviceLimit === null && !plan.perUnit) {
    add("deviceLimit", PLAN_RULE_MESSAGES.deviceLimit);
  }

  if (plan.type === "ONE_TIME") {
    if (plan.updatesMonths === null) add("updatesMonths", PLAN_RULE_MESSAGES.updatesMonths);
  } else if (plan.type !== "MAINTENANCE" && plan.updatesMonths !== null) {
    add("updatesMonths", PLAN_RULE_MESSAGES.noUpdatesMonths);
  }

  if (plan.perUnit) {
    if (!unitPriced) add("perUnit", PLAN_RULE_MESSAGES.perUnitType);
    else if (plan.maxQty === null) add("maxQty", PLAN_RULE_MESSAGES.maxQty);
  } else if (plan.maxQty !== null && plan.type !== "DEVICE_ADDON") {
    add("maxQty", PLAN_RULE_MESSAGES.maxQtyType);
  }

  if (plan.multiDevice && !plan.perUnit && (plan.deviceLimit ?? 1) <= 1) add("multiDevice", PLAN_RULE_MESSAGES.multiDevice);
  return issues;
}

const planFields = {
  name: text(2, 80, CATALOG_ERRORS.name),
  summary: z.string().trim().max(300, CATALOG_ERRORS.tooLong(300)).nullable(),
  includes: z
    .array(text(1, 80, "Write each line in 80 characters or fewer."))
    .max(MAX_INCLUDES, `List up to ${MAX_INCLUDES} items.`),
  pricePaise: z.int(CATALOG_ERRORS.price).min(0, CATALOG_ERRORS.price).max(MAX_PRICE_PAISE, CATALOG_ERRORS.price),
  interval: z.enum(BILLING_INTERVALS, PLAN_RULE_MESSAGES.intervalNeeded).nullable(),
  trialDays: int(1, 90).nullable(),
  deviceLimit: int(1, 1000).nullable(),
  perUnit: z.string().trim().regex(PER_UNIT_RE, "Use one lower-case word, e.g. terminal.").nullable(),
  maxQty: int(1, 100).nullable(),
  multiDevice: z.boolean(),
  updatesMonths: int(1, 120).nullable(),
  popular: z.boolean(),
  sortOrder: int(0, 999),
};

export const planCreateSchema = z
  .strictObject({
    id: slug(),
    productId: z.string().trim().regex(SLUG_RE, "Choose a product.").max(60),
    type: z.enum(PLAN_TYPES, "Choose a plan type."),
    ...planFields,
    summary: planFields.summary.default(null),
    includes: planFields.includes.default([]),
    interval: planFields.interval.default(null),
    trialDays: planFields.trialDays.default(null),
    deviceLimit: planFields.deviceLimit.default(null),
    perUnit: planFields.perUnit.default(null),
    maxQty: planFields.maxQty.default(null),
    multiDevice: planFields.multiDevice.default(false),
    updatesMonths: planFields.updatesMonths.default(null),
    popular: planFields.popular.default(false),
    sortOrder: planFields.sortOrder.default(0),
  })
  .superRefine((plan, ctx) => {
    for (const issue of planRuleIssues(plan)) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  });

/** Plan edits: everything except the id, product and type (licenses and orders refer to them). */
export const planUpdateSchema = z
  .strictObject({
    name: planFields.name.optional(),
    summary: planFields.summary.optional(),
    includes: planFields.includes.optional(),
    pricePaise: planFields.pricePaise.optional(),
    interval: planFields.interval.optional(),
    trialDays: planFields.trialDays.optional(),
    deviceLimit: planFields.deviceLimit.optional(),
    perUnit: planFields.perUnit.optional(),
    maxQty: planFields.maxQty.optional(),
    multiDevice: planFields.multiDevice.optional(),
    updatesMonths: planFields.updatesMonths.optional(),
    popular: planFields.popular.optional(),
    sortOrder: planFields.sortOrder.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), CATALOG_ERRORS.noChanges);

export type PlanCreateInput = z.output<typeof planCreateSchema>;
export type PlanUpdateInput = z.output<typeof planUpdateSchema>;

export const MAX_BULK_PLANS = 100;

// ---------- Releases ----------

const notes = z
  .array(z.string().trim().min(1, "Remove the empty note.").max(300, CATALOG_ERRORS.notes))
  .max(MAX_NOTES, `List up to ${MAX_NOTES} notes.`);

const version = z.string().trim().max(64, CATALOG_ERRORS.tooLong(64)).regex(VERSION_RE, CATALOG_ERRORS.version);
const channel = z.enum(RELEASE_CHANNELS, "Choose a channel.");

export const releaseCreateSchema = z.strictObject({
  productId: z.string().trim().regex(SLUG_RE, "Choose a product.").max(60),
  version,
  channel: channel.default("stable"),
  notes: notes.default([]),
});

export const releaseUpdateSchema = z
  .strictObject({ version: version.optional(), channel: channel.optional(), notes: notes.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), CATALOG_ERRORS.noChanges);

export type ReleaseCreateInput = z.output<typeof releaseCreateSchema>;
export type ReleaseUpdateInput = z.output<typeof releaseUpdateSchema>;

export const installerUploadSchema = z.strictObject({
  platform: z.enum(CATALOG_PLATFORMS, "Choose a platform."),
  fileName: z.string().trim().min(1, "This file needs a name.").max(150, CATALOG_ERRORS.tooLong(150)),
  sizeBytes: z
    .int("Choose a file.")
    .min(1, "This file is empty.")
    .max(MAX_INSTALLER_BYTES, "Installers can be up to 2 GB."),
});

export const installerConfirmSchema = z.strictObject({ uploadToken: z.string().min(1).max(4000) });

export type InstallerUploadInput = z.output<typeof installerUploadSchema>;
