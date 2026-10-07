import { describe, expect, it } from "vitest";
import { changedKeys, draftErrors, firstFieldErrors, patchFromDraft, toDraft } from "@/components/admin/settings/settings-form-model";
import { integrationStatuses } from "@/lib/admin/settings/integrations";
import {
  diffSection,
  formatSettingValue,
  isSettingsSectionId,
  sectionNote,
  SECTION_SETTING_KEYS,
  SETTINGS_PATCH_SCHEMAS,
  SETTINGS_SECTIONS,
  settingsSection,
} from "@/lib/admin/settings/model";
import { SETTING_DEFAULTS } from "@/lib/config";

describe("settings sections", () => {
  it("cover every editable key of their SiteSetting value", () => {
    // licensing.expiringDays is stored but fixed (EXPIRING_DAYS), so it is not a field.
    const fixed = new Set(["expiringDays"]);
    for (const section of SETTINGS_SECTIONS) {
      const keys = Object.keys(SETTING_DEFAULTS[SECTION_SETTING_KEYS[section.id]]).filter((k) => !fixed.has(k)).sort();
      expect(section.fields.map((f) => f.key).sort(), section.id).toEqual(keys);
      expect(Object.keys(SETTINGS_PATCH_SCHEMAS[section.id].shape).sort(), section.id).toEqual(keys);
    }
    expect(isSettingsSectionId("sample-notice")).toBe(true);
    expect(isSettingsSectionId("content.banner")).toBe(false);
    expect(sectionNote("business", { sample: true })).toBe("Placeholder values \u2014 replace before launch");
  });

  it("accepts only known fields of the right type", () => {
    expect(SETTINGS_PATCH_SCHEMAS.tax.safeParse({ gstRatePct: 18 }).success).toBe(true);
    expect(SETTINGS_PATCH_SCHEMAS.tax.safeParse({ gstRatePct: "18" }).success).toBe(false);
    expect(SETTINGS_PATCH_SCHEMAS.tax.safeParse({ nextInvoice: 1200 }).success).toBe(false);
    expect(SETTINGS_PATCH_SCHEMAS.business.safeParse({ sample: "yes" }).success).toBe(false);
    expect(SETTINGS_PATCH_SCHEMAS.licensing.safeParse({ downloadLinkMinutes: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("describes changes old -> new in form order", () => {
    const before = { ...SETTING_DEFAULTS.tax };
    const after = { ...before, sac: "998314", gstRatePct: 12 };
    expect(diffSection("tax", before, after)).toEqual([
      { field: "gstRatePct", label: "GST rate (%)", from: "18", to: "12" },
      { field: "sac", label: "SAC code", from: "997331", to: "998314" },
    ]);
    expect(diffSection("tax", before, { ...before })).toEqual([]);
    expect([true, false, 7, "", null, "x".repeat(200)].map(formatSettingValue)).toEqual(["On", "Off", "7", "(empty)", "(empty)", `${"x".repeat(119)}\u2026`]);
  });
});

describe("settings form model", () => {
  const tax = settingsSection("tax");
  const licensing = settingsSection("licensing");

  it("sends only changed fields with typed values", () => {
    const baseline = toDraft(tax, SETTING_DEFAULTS.tax);
    expect(baseline.gstRatePct).toBe("18");
    const draft = { ...baseline, gstRatePct: "18.0", sac: "998314" };
    expect(changedKeys(tax, baseline, draft)).toEqual(["sac"]);
    expect(patchFromDraft(tax, { ...draft, gstRatePct: " 12 " }, ["gstRatePct", "sac"])).toEqual({ gstRatePct: 12, sac: "998314" });
    const notice = settingsSection("sample-notice");
    const noticeDraft = toDraft(notice, SETTING_DEFAULTS["content.sampleNotice"]);
    expect(noticeDraft.enabled).toBe(true);
    expect(patchFromDraft(notice, { ...noticeDraft, enabled: false }, ["enabled"])).toEqual({ enabled: false });
  });

  it("offers no Expiring window: it is fixed at 60 days (EXPIRING_DAYS) and the PATCH refuses it", () => {
    expect(licensing.fields.map((f) => f.key)).toEqual(["selfServiceResetsPerYear", "downloadLinkMinutes"]);
    expect(SETTINGS_PATCH_SCHEMAS.licensing.safeParse({ expiringDays: 30 }).success).toBe(false);
  });

  it("catches numbers that do not parse and reads server field errors", () => {
    const draft = { ...toDraft(licensing, SETTING_DEFAULTS.licensing), selfServiceResetsPerYear: "", downloadLinkMinutes: "ten" };
    expect(draftErrors(licensing, draft, ["selfServiceResetsPerYear", "downloadLinkMinutes"])).toEqual({
      selfServiceResetsPerYear: "Enter a number.",
      downloadLinkMinutes: "Enter a number.",
    });
    expect(draftErrors(licensing, draft, [])).toEqual({});
    expect(firstFieldErrors({ gstin: ["Bad", "Worse"], "tax.sac": ["Nope"] })).toEqual({ gstin: "Bad", tax: "Nope" });
  });
});

describe("integration statuses", () => {
  const base = {
    NODE_ENV: "production" as const,
    PAYMENT_PROVIDER: "razorpay" as const,
    PAYMENT_KEY_ID: "rzp_live_SECRETKEYID",
    PAYMENT_KEY_SECRET: "shh-very-secret",
    PAYMENT_WEBHOOK_SECRET: "whsec-1234567890",
    STORAGE_DRIVER: "s3" as const,
    STORAGE_BUCKET: "axiomatic-installers",
    STORAGE_REGION: "ap-south-1",
    STORAGE_ENDPOINT: undefined,
    STORAGE_ACCESS_KEY_ID: "AKIA-EXAMPLE",
    STORAGE_SECRET_ACCESS_KEY: "storage-secret",
    EMAIL_TRANSPORT: "smtp" as const,
    EMAIL_FROM: "Axiomatic <no-reply@axiomatic.example>",
    SMTP_HOST: "smtp.example.net",
    REDIS_URL: undefined,
  };

  it("reports configured / missing / development and the payment mode, never a value", () => {
    const live = integrationStatuses(base);
    expect(live.map((i) => [i.id, i.provider, i.status, i.mode ?? null])).toEqual([
      ["payments", "Razorpay", "configured", "live"],
      ["storage", "S3-compatible bucket", "configured", null],
      ["email", "SMTP", "configured", null],
      ["redis", "Database buckets", "missing", null],
    ]);
    const text = JSON.stringify(live);
    for (const value of [base.PAYMENT_KEY_ID, base.PAYMENT_KEY_SECRET, base.STORAGE_BUCKET, base.STORAGE_SECRET_ACCESS_KEY, base.SMTP_HOST, base.EMAIL_FROM, "ap-south-1"]) {
      expect(text.includes(value), value).toBe(false);
    }
    const dev = integrationStatuses({ ...base, NODE_ENV: "development", PAYMENT_PROVIDER: "mock", STORAGE_DRIVER: "local", EMAIL_TRANSPORT: "console", PAYMENT_KEY_ID: "rzp_test_x" });
    expect(dev.map((i) => [i.status, i.mode ?? null])).toEqual([["development", "test"], ["development", null], ["development", null], ["development", null]]);
    const missing = integrationStatuses({ ...base, PAYMENT_KEY_SECRET: undefined, STORAGE_ACCESS_KEY_ID: undefined, SMTP_HOST: undefined, REDIS_URL: "redis://cache:6379" });
    expect(missing.map((i) => i.status)).toEqual(["missing", "missing", "missing", "configured"]);
  });
});
