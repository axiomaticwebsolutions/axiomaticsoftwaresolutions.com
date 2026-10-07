/**
 * Typed SiteSetting reader. One row per section, each a Zod-validated JSON value with defaults.
 *
 * Reading is lenient: unknown keys are dropped, missing keys take defaults, and a value that still fails
 * validation falls back to the section defaults with a warning (the site keeps working). Writing is strict:
 * admin routes merge their patch into the current value and validate it with `settingSchemas[key]`.
 * Secrets never live here (env only), and security bounds from the env always win over settings.
 */
import { z } from "zod";
import { DOCUMENT_PREFIX_RE } from "@/lib/counters";
import type { Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import type { TaxSettings as PricingTaxSettings } from "@/lib/pricing";
import { BILLING_ERRORS } from "@/lib/validation/billing";
import { makeEmailSchema, makePinSchema } from "@/lib/validation/contact";
import { gstinMatchesState, gstinStateName, isGstinFormat, normalizeGstin } from "@/lib/validation/gstin";
import { INDIAN_STATES } from "@/lib/validation/states";

export const SETTING_KEYS = ["business", "tax", "licensing", "content.banner", "content.sampleNotice"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Absolute ceiling for presigned download links, whatever settings or env say. */
export const MAX_DOWNLOAD_TTL_SECONDS = 600;

const businessShape = {
  legalName: z.string().trim().min(1, "Enter the legal name.").max(200),
  gstin: z.string().transform(normalizeGstin).refine(isGstinFormat, BILLING_ERRORS.gstin),
  address: z.string().trim().max(300),
  city: z.string().trim().max(80),
  state: z.enum(INDIAN_STATES, BILLING_ERRORS.state),
  pin: makePinSchema(BILLING_ERRORS.pin),
  supportEmail: makeEmailSchema(),
  /** Sales and demo enquiries (Contact page). */
  salesEmail: makeEmailSchema(),
  /** Questions about the terms and policies (Legal pages). */
  legalEmail: makeEmailSchema(),
  /** Requests under the privacy policy (access, correction, deletion). */
  privacyEmail: makeEmailSchema(),
  phone: z.string().trim().max(30),
  hours: z.string().trim().max(120),
  /** True while the details are placeholders (drives the "sample" labelling). */
  sample: z.boolean(),
};

const taxShape = {
  gstRatePct: z.number().min(0).max(40),
  sac: z.string().trim().regex(/^\d{6}$/, "SAC code should be 6 digits."),
  priceDisplay: z.enum(["exclusive", "inclusive"]),
  /**
   * Base of the invoice number ("AXS" -> AXS/26-27/1181); the FY and the running number are never editable.
   * At most 3 characters so numbers stay within GST's 16-character limit up to 999,999 per year (lib/counters.ts).
   */
  invoicePrefix: z.string().trim().regex(DOCUMENT_PREFIX_RE, "Use up to 3 characters: A-Z, 0-9 or -."),
  creditNotePrefix: z.string().trim().regex(DOCUMENT_PREFIX_RE, "Use up to 3 characters: A-Z, 0-9 or -."),
};

const licensingShape = {
  selfServiceResetsPerYear: z.number().int().min(0).max(12),
  /**
   * Kept so stored values stay valid; not editable and not read: "Expiring" is fixed at EXPIRING_DAYS
   * (lib/licensing/status.ts, decisions.md) everywhere.
   */
  expiringDays: z.number().int().min(1).max(365),
  /** Settings may only tighten the download TTL; see downloadTtlSeconds(). */
  downloadLinkMinutes: z.number().int().min(1).max(MAX_DOWNLOAD_TTL_SECONDS / 60),
};

const bannerShape = {
  enabled: z.boolean(),
  text: z.string().trim().max(200),
};

type Shape = Record<string, z.ZodType>;

/** Builds the lenient (read) and strict (write) variants of a section from one shape and its cross-field rule. */
function section<S extends Shape>(shape: S, rule?: (value: z.output<z.ZodObject<S>>, ctx: z.RefinementCtx) => void) {
  const lenient = z.object(shape);
  const strict = z.strictObject(shape);
  return {
    lenient: rule ? lenient.superRefine(rule) : lenient,
    strict: rule ? strict.superRefine(rule) : strict,
  };
}

const sections = {
  business: section(businessShape, (v, ctx) => {
    if (isGstinFormat(v.gstin) && !gstinMatchesState(v.gstin, v.state)) {
      const registered = gstinStateName(v.gstin);
      ctx.addIssue({
        code: "custom",
        path: ["gstin"],
        message: registered ? `This GSTIN is registered in ${registered}, not ${v.state}.` : BILLING_ERRORS.gstin,
      });
    }
  }),
  tax: section(taxShape, (v, ctx) => {
    if (v.invoicePrefix === v.creditNotePrefix) {
      ctx.addIssue({ code: "custom", path: ["creditNotePrefix"], message: "Use a different prefix from invoices." });
    }
  }),
  licensing: section(licensingShape),
  "content.banner": section(bannerShape, (v, ctx) => {
    if (v.enabled && v.text === "") ctx.addIssue({ code: "custom", path: ["text"], message: "Enter the banner text." });
  }),
  "content.sampleNotice": section(bannerShape),
} as const;

export type BusinessSettings = z.output<typeof sections.business.strict>;
export type TaxSettings = z.output<typeof sections.tax.strict>;
export type LicensingSettings = z.output<typeof sections.licensing.strict>;
export type BannerSettings = z.output<(typeof sections)["content.banner"]["strict"]>;
export type SampleNoticeSettings = z.output<(typeof sections)["content.sampleNotice"]["strict"]>;

export type SiteSettings = {
  business: BusinessSettings;
  tax: TaxSettings;
  licensing: LicensingSettings;
  "content.banner": BannerSettings;
  "content.sampleNotice": SampleNoticeSettings;
};
export type SettingValue<K extends SettingKey> = SiteSettings[K];

/** Defaults: the prototype's placeholder seller details (labelled sample) and the policies in docs/decisions.md. */
export const SETTING_DEFAULTS: Readonly<SiteSettings> = Object.freeze({
  business: {
    legalName: "Axiomatic Software Solutions (placeholder)",
    gstin: "27AAAAA0000A1Z5",
    address: "Registered office address (placeholder)",
    city: "Pune",
    state: "Maharashtra",
    pin: "411001",
    supportEmail: "support@axiomatic.example",
    salesEmail: "sales@axiomatic.example",
    legalEmail: "legal@axiomatic.example",
    privacyEmail: "privacy@axiomatic.example",
    phone: "+91 00000 00000",
    hours: "Mon\u2013Sat, 10:00\u201319:00 IST",
    sample: true,
  },
  tax: {
    gstRatePct: 18,
    sac: "997331",
    priceDisplay: "exclusive",
    invoicePrefix: "AXS",
    creditNotePrefix: "AXC",
  },
  licensing: {
    selfServiceResetsPerYear: 3,
    expiringDays: 60,
    downloadLinkMinutes: 10,
  },
  "content.banner": { enabled: false, text: "" },
  "content.sampleNotice": {
    enabled: true,
    text: "Prototype \u00B7 Prices, policies and screenshots are sample content and configurable",
  },
});

/** Strict schemas for complete section values. Admin writes validate `{ ...current, ...patch }` with these. */
export const settingSchemas: { [K in SettingKey]: z.ZodType<SiteSettings[K], unknown> } = {
  business: sections.business.strict,
  tax: sections.tax.strict,
  licensing: sections.licensing.strict,
  "content.banner": sections["content.banner"].strict,
  "content.sampleNotice": sections["content.sampleNotice"].strict,
};

const readSchemas: { [K in SettingKey]: z.ZodType<SiteSettings[K], unknown> } = {
  business: sections.business.lenient,
  tax: sections.tax.lenient,
  licensing: sections.licensing.lenient,
  "content.banner": sections["content.banner"].lenient,
  "content.sampleNotice": sections["content.sampleNotice"].lenient,
};

function defaultsFor<K extends SettingKey>(key: K): SiteSettings[K] {
  return structuredClone(SETTING_DEFAULTS[key]);
}

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

/** Parses a stored JSON value over the defaults. Invalid values fall back to the defaults with a warning. */
export function parseStoredSetting<K extends SettingKey>(key: K, stored: unknown): SiteSettings[K] {
  if (stored === undefined || stored === null) return defaultsFor(key);
  if (typeof stored !== "object" || Array.isArray(stored)) {
    log.warn("site_setting_invalid", { setting: key, problem: "not an object" });
    return defaultsFor(key);
  }
  const result = readSchemas[key].safeParse({ ...defaultsFor(key), ...stored });
  if (result.success) return result.data;
  // Paths only: stored values may be long or user-entered.
  log.warn("site_setting_invalid", { setting: key, fields: result.error.issues.map((i) => i.path.join(".") || "(root)") });
  return defaultsFor(key);
}

/** Every section, parsed with defaults, in one query. */
export async function getSettings(db: Db): Promise<SiteSettings> {
  const rows = await db.siteSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const stored = new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
  return {
    business: parseStoredSetting("business", stored.get("business")),
    tax: parseStoredSetting("tax", stored.get("tax")),
    licensing: parseStoredSetting("licensing", stored.get("licensing")),
    "content.banner": parseStoredSetting("content.banner", stored.get("content.banner")),
    "content.sampleNotice": parseStoredSetting("content.sampleNotice", stored.get("content.sampleNotice")),
  };
}

/** One section, parsed with defaults. */
export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SiteSettings[K]> {
  const row = await db.siteSetting.findUnique({ where: { key } });
  return parseStoredSetting(key, row?.value);
}

/** Input for lib/pricing quote(): the GST rate and the company state that decides intra- vs inter-state. */
export function taxSettingsForPricing(settings: Pick<SiteSettings, "business" | "tax">): PricingTaxSettings {
  return { gstRatePct: settings.tax.gstRatePct, companyState: settings.business.state };
}

/** Presigned download TTL: min(setting, env DOWNLOAD_LINK_TTL_SECONDS, 600 s). Settings can only tighten it. */
export function downloadTtlSeconds(
  settings: Pick<SiteSettings, "licensing">,
  envTtlSeconds: number = getEnv().DOWNLOAD_LINK_TTL_SECONDS,
): number {
  return Math.max(1, Math.min(settings.licensing.downloadLinkMinutes * 60, envTtlSeconds, MAX_DOWNLOAD_TTL_SECONDS));
}
