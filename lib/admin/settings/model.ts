/**
 * Business & integration settings (Admin Console.dc.html `mods.settings`; decisions.md Phase 6 "Settings"): the form
 * sections, their fields, the PATCH body schemas and the audit wording. Pure and client-safe (lib/config.ts is only
 * imported for types: it reads the server environment).
 *
 * Sections map to SiteSetting keys: business, tax, licensing and content.sampleNotice ("sample-notice" in URLs). Each
 * save sends only the changed fields; the server merges them into the stored value, validates the result with
 * lib/config settingSchemas, writes one "Updated settings" audit row per changed field ("old → new") and revalidates
 * the storefront's settings cache. Secrets never live here: integrations show configured / not configured from env.
 */
import { z } from "zod";
import type { IconName } from "@/components/icons/icon";
import type { SettingKey, SiteSettings } from "@/lib/config";
import { INDIAN_STATES } from "@/lib/validation/states";

export const SETTINGS_SECTION_IDS = ["business", "tax", "licensing", "sample-notice"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export const SECTION_SETTING_KEYS = {
  business: "business",
  tax: "tax",
  licensing: "licensing",
  "sample-notice": "content.sampleNotice",
} as const satisfies Record<SettingsSectionId, SettingKey>;

export type SectionKey<S extends SettingsSectionId> = (typeof SECTION_SETTING_KEYS)[S];
export type SectionValue<S extends SettingsSectionId> = SiteSettings[SectionKey<S>];

export type SettingsFieldKind = "text" | "email" | "tel" | "number" | "select" | "switch";

export type SettingsFieldDef = {
  /** Key inside the section's SiteSetting value. */
  key: string;
  label: string;
  kind: SettingsFieldKind;
  mono?: boolean;
  /** Spans the whole form row. */
  wide?: boolean;
  help?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "tel";
  autoComplete?: string;
  /** Upper-cases while typing (GSTIN, prefixes). */
  upper?: boolean;
};

export type SettingsSectionDef = {
  id: SettingsSectionId;
  title: string;
  description: string;
  icon: IconName;
  fields: readonly SettingsFieldDef[];
};

const STATE_OPTIONS = INDIAN_STATES.map((s) => ({ value: s, label: s }));

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: "business",
    title: "Business details",
    description: "Shown on invoices and the website footer.",
    icon: "apartment",
    fields: [
      { key: "legalName", label: "Legal name", kind: "text", wide: true, maxLength: 200, autoComplete: "organization" },
      { key: "gstin", label: "GSTIN", kind: "text", mono: true, maxLength: 15, upper: true, help: "Its state code must match the state below." },
      { key: "state", label: "State", kind: "select", options: STATE_OPTIONS },
      { key: "address", label: "Address", kind: "text", wide: true, maxLength: 300, autoComplete: "street-address" },
      { key: "city", label: "City", kind: "text", maxLength: 80 },
      { key: "pin", label: "PIN code", kind: "text", maxLength: 6, inputMode: "numeric", mono: true },
      { key: "supportEmail", label: "Support email", kind: "email", maxLength: 254 },
      { key: "salesEmail", label: "Sales email", kind: "email", maxLength: 254 },
      { key: "legalEmail", label: "Legal email", kind: "email", maxLength: 254 },
      { key: "privacyEmail", label: "Privacy email", kind: "email", maxLength: 254 },
      { key: "phone", label: "Phone", kind: "tel", maxLength: 30, inputMode: "tel" },
      { key: "hours", label: "Support hours", kind: "text", maxLength: 120 },
      {
        key: "sample",
        label: "Placeholder details",
        kind: "switch",
        wide: true,
        help: "While on, the website and invoices label these details as sample. Turn it off once the real details are in.",
      },
    ],
  },
  {
    id: "tax",
    title: "Tax & invoicing",
    description: "GST rate, SAC code and invoice numbering.",
    icon: "percent",
    fields: [
      { key: "gstRatePct", label: "GST rate (%)", kind: "number", min: 0, max: 40, step: 0.01, inputMode: "decimal" },
      { key: "sac", label: "SAC code", kind: "text", mono: true, maxLength: 6, inputMode: "numeric" },
      {
        key: "priceDisplay",
        label: "Storefront prices",
        kind: "select",
        options: [
          { value: "exclusive", label: "Excluding GST" },
          { value: "inclusive", label: "Including GST" },
        ],
      },
      { key: "invoicePrefix", label: "Invoice prefix", kind: "text", mono: true, maxLength: 3, upper: true, help: "Up to 3 characters: A-Z, 0-9 or -." },
      { key: "creditNotePrefix", label: "Credit note prefix", kind: "text", mono: true, maxLength: 3, upper: true, help: "Up to 3 characters: A-Z, 0-9 or -." },
    ],
  },
  {
    id: "licensing",
    title: "License policy",
    description: "Defaults for activation and downloads.",
    icon: "key",
    fields: [
      { key: "selfServiceResetsPerYear", label: "Self-service deactivations / year", kind: "number", min: 0, max: 12, step: 1, inputMode: "numeric" },
      { key: "downloadLinkMinutes", label: "Download link validity (min)", kind: "number", min: 1, max: 10, step: 1, inputMode: "numeric", help: "At most 10 minutes." },
    ],
  },
  {
    id: "sample-notice",
    title: "Sample notice",
    description: "The dark strip above the storefront header.",
    icon: "info",
    fields: [
      { key: "enabled", label: "Show the sample notice", kind: "switch", wide: true },
      { key: "text", label: "Notice text", kind: "text", wide: true, maxLength: 200 },
    ],
  },
];

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  const found = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!found) throw new RangeError(`Unknown settings section ${id}`);
  return found;
}

/** Footer note of each section (prototype notes; the business note depends on the sample flag). */
export function sectionNote(id: SettingsSectionId, opts: { sample?: boolean } = {}): string {
  switch (id) {
    case "business":
      return opts.sample ? "Placeholder values \u2014 replace before launch" : "Changes apply to new invoices; issued invoices keep their details.";
    case "tax":
      return "Confirm rates with your CA";
    case "licensing":
      return "Applies to all products unless overridden";
    case "sample-notice":
      return "Turn it off once prices and policies are final.";
  }
}

// ---------- PATCH bodies ----------

const text = (max: number) => z.string().max(max * 2);
const num = z.number().finite();

/**
 * PATCH /api/admin/settings/:section bodies: the changed fields only (strict: unknown keys are refused). Types and
 * rough sizes are checked here; the merged value is then validated with lib/config settingSchemas, whose messages
 * come back as field errors.
 */
export const SETTINGS_PATCH_SCHEMAS = {
  business: z.strictObject({
    legalName: text(200).optional(),
    gstin: text(15).optional(),
    address: text(300).optional(),
    city: text(80).optional(),
    state: text(80).optional(),
    pin: text(6).optional(),
    supportEmail: text(254).optional(),
    salesEmail: text(254).optional(),
    legalEmail: text(254).optional(),
    privacyEmail: text(254).optional(),
    phone: text(30).optional(),
    hours: text(120).optional(),
    sample: z.boolean().optional(),
  }),
  tax: z.strictObject({
    gstRatePct: num.optional(),
    sac: text(6).optional(),
    priceDisplay: text(20).optional(),
    invoicePrefix: text(3).optional(),
    creditNotePrefix: text(3).optional(),
  }),
  // No expiringDays: "Expiring" is fixed at EXPIRING_DAYS (60, decisions.md) in every status, list, report and the
  // portal, so an editable window would be audited and change nothing.
  licensing: z.strictObject({
    selfServiceResetsPerYear: num.optional(),
    downloadLinkMinutes: num.optional(),
  }),
  "sample-notice": z.strictObject({
    enabled: z.boolean().optional(),
    text: text(200).optional(),
  }),
} as const satisfies Record<SettingsSectionId, z.ZodType>;

export type SettingsPatch<S extends SettingsSectionId> = z.output<(typeof SETTINGS_PATCH_SCHEMAS)[S]>;

// ---------- Audit wording ----------

const MAX_AUDIT_VALUE = 120;

/** A setting value as the audit log shows it: On/Off, numbers as typed, "(empty)", long text cut at 120 characters. */
export function formatSettingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "\u2014";
  if (value === null || value === undefined) return "(empty)";
  const s = String(value).trim();
  if (s === "") return "(empty)";
  return s.length > MAX_AUDIT_VALUE ? `${s.slice(0, MAX_AUDIT_VALUE - 1)}\u2026` : s;
}

/** Field label for the audit target "Tax & invoicing · Invoice prefix" (the key itself when unknown). */
export function fieldLabel(id: SettingsSectionId, key: string): string {
  return settingsSection(id).fields.find((f) => f.key === key)?.label ?? key;
}

export type SettingChange = { field: string; label: string; from: string; to: string };

/** Changed fields between two section values, in form order (values compared after validation/normalisation). */
export function diffSection(id: SettingsSectionId, before: Record<string, unknown>, after: Record<string, unknown>): SettingChange[] {
  const keys = settingsSection(id).fields.map((f) => f.key);
  for (const key of Object.keys(after)) if (!keys.includes(key)) keys.push(key);
  return keys
    .filter((key) => !Object.is(before[key], after[key]))
    .map((key) => ({ field: key, label: fieldLabel(id, key), from: formatSettingValue(before[key]), to: formatSettingValue(after[key]) }));
}

// ---------- Integrations (read-only, from env presence) ----------

export type IntegrationStatus = "configured" | "missing" | "development";

export type IntegrationView = {
  id: "payments" | "storage" | "email" | "redis";
  title: string;
  description: string;
  icon: IconName;
  /** Driver kind, never a value: "Razorpay", "S3-compatible bucket", "SMTP", "Redis". */
  provider: string;
  status: IntegrationStatus;
  /** Payments only. */
  mode?: "test" | "live";
  /** Environment variable NAMES the integration reads (never their values). */
  envNames: readonly string[];
  note: string;
};

export const INTEGRATION_STATUS_LABELS: Readonly<Record<IntegrationStatus, string>> = {
  configured: "Configured",
  missing: "Not configured",
  development: "Development only",
};

/** Data of the Settings page (GET /api/admin/settings). */
export type AdminSettingsData = {
  business: SiteSettings["business"];
  tax: SiteSettings["tax"];
  licensing: SiteSettings["licensing"];
  sampleNotice: SiteSettings["content.sampleNotice"];
  /** Read-only facts next to the forms. */
  facts: {
    /** "AXS/26-27/1181": the number the next paid order gets (null when the series is full). */
    nextInvoiceNumber: string | null;
    nextCreditNoteNumber: string | null;
    /** LICENSE_OFFLINE_GRACE_DAYS (env). */
    offlineGraceDays: number;
    /** Licenses ending within this many days read as Expiring (EXPIRING_DAYS; fixed, not a setting). */
    expiringDays: number;
  };
  integrations: IntegrationView[];
};

export const SETTINGS_COPY = {
  save: "Save",
  saved: (title: string) => `${title} saved`,
  noChanges: "No changes to save",
  readOnlyFacts: {
    nextInvoice: "Next invoice number",
    nextCreditNote: "Next credit note number",
    nextInvoiceHelp: "Numbers are never reused or edited. The financial year changes on 1 April.",
    seriesFull: "Series full \u2014 shorten the prefix",
    offlineGrace: "Offline grace (days)",
    offlineGraceHelp: "Set on the server (LICENSE_OFFLINE_GRACE_DAYS).",
    expiring: "Expiring window (days)",
    expiringHelp: "Licenses ending within this many days read as Expiring.",
    keyReveal: "Key reveal needs password",
    keyRevealValue: "Always",
  },
  integrationsTitle: "Integrations",
  integrationsDescription:
    "Secrets live in environment variables on the server. This page shows only whether each integration is configured.",
  fields: { provider: "Provider", status: "Status", mode: "Mode" },
  modes: { test: "Test", live: "Live" },
  envPrefix: "Environment:",
} as const;
