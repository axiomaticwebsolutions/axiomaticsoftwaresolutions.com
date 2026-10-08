import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedKeys, draftErrors, firstFieldErrors, patchFromDraft, toDraft } from "@/components/admin/settings/settings-form-model";
import { integrationsData, redisState, type IntegrationViewEnv } from "@/lib/admin/settings/integrations";
import { integrationProblem, type IntegrationState } from "@/lib/admin/settings/integrations-model";
import { sealIntegrationSecret } from "@/lib/integrations/crypto";
import type { IntegrationKind } from "@/lib/integrations/model";
import { getIntegrationSnapshot, setIntegrationEnvForTests, setIntegrationKeyForTests, setIntegrationRowsLoader } from "@/lib/integrations/resolver";
import type { IntegrationRow } from "@/lib/integrations/types";
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

describe("integration views (Admin > Settings > Integrations)", () => {
  const live = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "razorpay",
    PAYMENT_KEY_ID: "rzp_live_SECRETKEYID01",
    PAYMENT_KEY_SECRET: "shh-very-secret",
    PAYMENT_WEBHOOK_SECRET: "whsec-1234567890",
    STORAGE_DRIVER: "s3",
    STORAGE_BUCKET: "axiomatic-installers",
    STORAGE_REGION: "ap-south-1",
    STORAGE_ACCESS_KEY_ID: "AKIA-EXAMPLE",
    STORAGE_SECRET_ACCESS_KEY: "storage-secret",
    EMAIL_TRANSPORT: "smtp",
    EMAIL_FROM: "Axiomatic <no-reply@axiomatic.example>",
    SMTP_HOST: "smtp.example.net",
    SMTP_USER: "mailer",
    SMTP_PASSWORD: "smtp-password-1",
  };
  const ENV_SECRETS = [live.PAYMENT_KEY_SECRET, live.PAYMENT_WEBHOOK_SECRET, live.STORAGE_SECRET_ACCESS_KEY, live.SMTP_PASSWORD];
  const ikm = Buffer.alloc(32, 7);
  const AT = new Date("2026-10-08T08:00:00Z");
  const appEnv = (env: Record<string, string | undefined>, redis?: string): IntegrationViewEnv => ({
    NODE_ENV: env.NODE_ENV === "production" ? "production" : "development",
    REDIS_URL: redis,
    APP_URL: "https://shop.axiomatic.example",
  });

  function row(kind: IntegrationKind, settings: Record<string, unknown>, secrets: Record<string, string>): IntegrationRow {
    return {
      kind,
      settings,
      revision: 3,
      createdAt: AT,
      updatedAt: AT,
      updatedBy: { id: "u1", name: "Asha Rao" },
      secrets: Object.entries(secrets).map(([field, value]) => ({
        field,
        ciphertext: sealIntegrationSecret(kind, field, value, ikm),
        last4: value.length >= 16 ? value.slice(-4) : null,
        updatedAt: AT,
        updatedBy: { id: "u1", name: "Asha Rao" },
      })),
    };
  }

  beforeEach(() => setIntegrationKeyForTests(ikm));
  afterEach(() => {
    setIntegrationEnvForTests(null);
    setIntegrationKeyForTests(null);
    setIntegrationRowsLoader(async () => []);
  });

  async function views(env: Record<string, string | undefined>, opts: { canManage: boolean; rows?: IntegrationRow[]; redis?: string }) {
    setIntegrationEnvForTests(env);
    setIntegrationRowsLoader(async () => opts.rows ?? []);
    const snapshot = await getIntegrationSnapshot({ fresh: true });
    return integrationsData(snapshot, { canManage: opts.canManage, env: appEnv(env, opts.redis), lastSignedWebhookAt: null });
  }
  const byId = (items: IntegrationState[], id: string) => items.find((i) => i.id === id) as IntegrationState;

  it("status only: source, provider, mode and env NAMES, never a value, a form or a hint", async () => {
    const data = await views(live, { canManage: false });
    expect(data.canManage).toBe(false);
    expect(data.items.map((i) => [i.id, i.source, i.provider, i.mode, i.problem, i.development])).toEqual([
      ["payments", "env", "Razorpay", "live", null, false],
      ["storage", "env", "S3-compatible bucket", null, null, false],
      ["email", "env", "SMTP", null, null, false],
    ]);
    expect(data.items.every((i) => i.form === null && i.saved === null)).toBe(true);
    expect(byId(data.items, "payments").envNames).toEqual(["PAYMENT_PROVIDER", "PAYMENT_KEY_ID", "PAYMENT_KEY_SECRET", "PAYMENT_WEBHOOK_SECRET"]);
    const text = JSON.stringify(data);
    for (const value of [...ENV_SECRETS, live.PAYMENT_KEY_ID, live.STORAGE_BUCKET, live.SMTP_HOST, live.EMAIL_FROM, live.SMTP_USER, "ap-south-1", "no-reply@"]) {
      expect(text.includes(value), value).toBe(false);
    }
    expect(data.redis).toEqual(redisState({ NODE_ENV: "production", REDIS_URL: undefined }));
    expect([data.redis.status, data.redis.provider, data.redis.note]).toEqual(["missing", "Database buckets", "Set on the server: a wrong value here would block every sign-in."]);
  });

  it("Owner form from the server file: non-secret values prefilled, secrets never described beyond the source", async () => {
    const data = await views(live, { canManage: true });
    const payments = byId(data.items, "payments");
    expect(payments.form).toEqual({
      kind: "payments",
      prefilledFrom: "env",
      values: { keyId: live.PAYMENT_KEY_ID },
      secrets: { keySecret: { set: false, last4: null, updatedAt: null, updatedBy: null }, webhookSecret: { set: false, last4: null, updatedAt: null, updatedBy: null } },
      webhookUrl: "https://shop.axiomatic.example/api/webhooks/payments/razorpay",
      lastSignedWebhookAt: null,
    });
    // Both providers' fields: the SES ones start from their defaults (Mumbai, nothing else).
    expect(byId(data.items, "email").form?.values).toEqual({
      provider: "smtp",
      host: "smtp.example.net",
      port: 587,
      security: "starttls",
      username: "mailer",
      region: "ap-south-1",
      accessKeyId: "",
      configurationSet: "",
      fromName: "Axiomatic",
      fromAddress: "no-reply@axiomatic.example",
    });
    expect(byId(data.items, "storage").form?.values).toEqual({ preset: "aws", endpoint: "", region: "ap-south-1", bucket: "axiomatic-installers", accessKeyId: "AKIA-EXAMPLE", forcePathStyle: false });
    const text = JSON.stringify(data);
    for (const secret of ENV_SECRETS) expect(text.includes(secret), secret).toBe(false);
  });

  it("Amazon SES from the server file: provider label, the SES variable names and the SES form values", async () => {
    const ses = {
      ...live,
      EMAIL_TRANSPORT: "ses",
      SES_REGION: "eu-west-1",
      SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      SES_SECRET_ACCESS_KEY: "ses-secret-access-key-01",
      SES_CONFIGURATION_SET: "axs-events",
    };
    const status = byId((await views(ses, { canManage: false })).items, "email");
    expect([status.source, status.provider, status.form]).toEqual(["env", "Amazon SES (API)", null]);
    expect(status.envNames).toEqual(["EMAIL_TRANSPORT", "EMAIL_FROM", "SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_CONFIGURATION_SET"]);
    expect(JSON.stringify(status)).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ses-secret-access-key|eu-west-1/);
    const owner = byId((await views(ses, { canManage: true })).items, "email");
    expect(owner.form?.values).toMatchObject({ provider: "ses", region: "eu-west-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", configurationSet: "axs-events", fromName: "Axiomatic" });
    expect(owner.form?.secrets).toEqual({
      password: { set: false, last4: null, updatedAt: null, updatedBy: null },
      secretAccessKey: { set: false, last4: null, updatedAt: null, updatedBy: null },
    });
    expect(JSON.stringify(owner)).not.toContain("ses-secret-access-key");
    // SMTP keeps listing the SMTP names.
    expect(byId((await views(live, { canManage: false })).items, "email").envNames).toEqual(["EMAIL_TRANSPORT", "EMAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"]);
  });

  it("shows the release-day stand-ins as not configured and leaves them out of the form", async () => {
    // The values on the live test site (docs/server-runbook.md 5.1).
    const standIns = {
      ...live,
      PAYMENT_KEY_ID: "rzp_test_pending",
      PAYMENT_KEY_SECRET: "pending-razorpay-secret",
      SMTP_HOST: "smtp-pending.invalid",
      SMTP_USER: "pending",
      SMTP_PASSWORD: "pending",
      STORAGE_ENDPOINT: "https://r2-pending.invalid",
      STORAGE_BUCKET: "axiomatic-files-pending",
      STORAGE_ACCESS_KEY_ID: "pending-r2",
      STORAGE_SECRET_ACCESS_KEY: "pending-r2-secret",
      STORAGE_REGION: "auto",
      STORAGE_FORCE_PATH_STYLE: "true",
    };
    const data = await views(standIns, { canManage: true });
    expect(data.items.map((i) => [i.source, i.provider, i.mode, i.problem])).toEqual([
      ["none", "Not set", null, "The server file has values that can’t work (PAYMENT_KEY_ID). Enter the details here."],
      ["none", "Not set", null, "The server file has values that can’t work (STORAGE_ENDPOINT). Enter the details here."],
      ["none", "Not set", null, "The server file has values that can’t work (SMTP_HOST). Enter the details here."],
    ]);
    expect(byId(data.items, "payments").form?.values).toEqual({ keyId: "" });
    // Only provider-shaped choices and the sender survive; no stand-in username, bucket or access key ID.
    expect(byId(data.items, "email").form?.values).toMatchObject({ host: "", username: "", fromName: "Axiomatic", fromAddress: "no-reply@axiomatic.example" });
    expect(byId(data.items, "storage").form?.values).toEqual({ preset: "r2", endpoint: "", region: "auto", bucket: "", accessKeyId: "", forcePathStyle: true });
    expect(JSON.stringify(data)).not.toContain(".invalid");
    expect(JSON.stringify(data)).not.toContain("pending");
    const statusOnly = await views(standIns, { canManage: false });
    expect(byId(statusOnly.items, "payments").problem).toBe("The server file has values that can’t work (PAYMENT_KEY_ID).");
    const none = await views({ NODE_ENV: "production" }, { canManage: true });
    expect(none.items.map((i) => i.problem)).toEqual(["Not set up yet.", "Not set up yet.", "Not set up yet."]);
    expect(none.items.map((i) => i.form?.prefilledFrom)).toEqual(["defaults", "defaults", "defaults"]);
    expect(byId(none.items, "storage").form?.values).toEqual({ preset: "aws", endpoint: "", region: "ap-south-1", bucket: "", accessKeyId: "", forcePathStyle: false });
  });

  it("marks the development drivers", async () => {
    const dev = await views({ NODE_ENV: "development", PAYMENT_KEY_SECRET: "dev-secret-123", PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret-123" }, { canManage: true, redis: "redis://cache:6379" });
    expect(dev.items.map((i) => [i.provider, i.development, i.mode])).toEqual([
      ["Mock provider", true, "test"],
      ["Local disk", true, null],
      ["Console (dev mailbox)", true, null],
    ]);
    expect(dev.redis.status).toBe("configured");
  });

  it("Admin rows win as a whole: hints with the last 4 of long secrets, who and when, never a value", async () => {
    const KEY_SECRET = "admin-key-secret-0001";
    const WEBHOOK_SECRET = "admin-webhook-secret-0002";
    const SMTP_PASSWORD = "short-pass";
    const rows = [
      row("payments", { provider: "razorpay", keyId: "rzp_test_AdminKey0001" }, { keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }),
      row("email", { host: "smtp.mailer.example", port: 465, security: "tls", username: "mailer", fromName: "Axiomatic", fromAddress: "no-reply@axiomatic.example" }, { password: SMTP_PASSWORD }),
    ];
    const data = await views(live, { canManage: true, rows });
    const payments = byId(data.items, "payments");
    expect([payments.source, payments.mode, payments.saved]).toEqual(["admin", "test", { revision: 3, updatedAt: AT.toISOString(), updatedBy: "Asha Rao" }]);
    expect(payments.form).toMatchObject({
      prefilledFrom: "admin",
      values: { keyId: "rzp_test_AdminKey0001" },
      secrets: {
        keySecret: { set: true, last4: "0001", updatedAt: AT.toISOString(), updatedBy: "Asha Rao" },
        webhookSecret: { set: true, last4: "0002", updatedAt: AT.toISOString(), updatedBy: "Asha Rao" },
      },
    });
    const email = byId(data.items, "email");
    expect(email.form?.secrets).toEqual({
      password: { set: true, last4: null, updatedAt: AT.toISOString(), updatedBy: "Asha Rao" },
      secretAccessKey: { set: false, last4: null, updatedAt: null, updatedBy: null },
    });
    expect(email.form?.values).toMatchObject({ host: "smtp.mailer.example", port: 465, security: "tls" });
    // Storage has no row: the env file still decides there.
    expect(byId(data.items, "storage").source).toBe("env");
    const text = JSON.stringify(data);
    for (const secret of [KEY_SECRET, WEBHOOK_SECRET, SMTP_PASSWORD, ...ENV_SECRETS]) expect(text.includes(secret), secret).toBe(false);
    for (const r of rows) for (const s of r.secrets) expect(text.includes(s.ciphertext)).toBe(false);
  });

  it("explains a cleared or unreadable Admin secret without falling back to the server file", async () => {
    const cleared = [row("payments", { provider: "razorpay", keyId: "rzp_test_AdminKey0001" }, { keySecret: "admin-key-secret-0001" })];
    const owner = await views(live, { canManage: true, rows: cleared });
    expect(byId(owner.items, "payments")).toMatchObject({ source: "none", mode: null, problem: "Webhook secret was cleared. Enter a new one to turn this back on." });
    const other = await views(live, { canManage: false, rows: cleared });
    expect(byId(other.items, "payments").problem).toBe("Webhook secret was cleared.");
    const foreign = row("payments", { provider: "razorpay", keyId: "rzp_test_AdminKey0001" }, { keySecret: "admin-key-secret-0001", webhookSecret: "admin-webhook-secret-0002" });
    setIntegrationKeyForTests(Buffer.alloc(32, 9));
    setIntegrationEnvForTests(live);
    setIntegrationRowsLoader(async () => [foreign]);
    const unreadable = integrationsData(await getIntegrationSnapshot({ fresh: true }), { canManage: true, env: appEnv(live) });
    expect(byId(unreadable.items, "payments").problem).toBe("Saved secrets can’t be read (the server key changed?). Enter them again.");
    expect(integrationProblem("payments", "admin_incomplete", ["keySecret", "webhookSecret"], { canManage: true })).toBe(
      "Key secret and Webhook secret were cleared. Enter new ones to turn this back on.",
    );
    expect(integrationProblem("storage", "admin_invalid", ["endpoint"], { canManage: true })).toBe("The saved settings can’t be used here: Endpoint.");
    expect(integrationProblem("email", "env_incomplete", ["SMTP_HOST", "EMAIL_FROM"], { canManage: false })).toBe("The server file is missing SMTP_HOST, EMAIL_FROM.");
  });
});
