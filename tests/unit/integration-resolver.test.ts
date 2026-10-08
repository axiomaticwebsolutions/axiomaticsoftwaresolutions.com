/**
 * The integration resolver (lib/integrations/resolver.ts; docs/admin-integrations-design.md sections 3 and 7):
 * precedence per integration as a whole, fail-closed Admin rows, and the process-wide cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealIntegrationSecret } from "@/lib/integrations/crypto";
import {
  getIntegrationSnapshot,
  INTEGRATION_CACHE_TTL_MS,
  invalidateIntegrations,
  resolveEmail,
  resolvePayments,
  resolveStorage,
  setIntegrationEnvForTests,
  setIntegrationKeyForTests,
  setIntegrationRowsLoader,
} from "@/lib/integrations/resolver";
import type { IntegrationKind } from "@/lib/integrations/model";
import { integrationSlot } from "@/lib/integrations/slot";
import type { IntegrationRow } from "@/lib/integrations/types";
import { setLogSink } from "@/lib/log";

const ikm = Buffer.alloc(32, 3);
const AT = new Date("2026-10-08T08:00:00Z");
const KEY_SECRET = "admin-key-secret-0001";
const WEBHOOK_SECRET = "admin-webhook-secret-0001";

function row(kind: IntegrationKind, settings: Record<string, unknown>, secrets: Record<string, string>, key: Buffer = ikm): IntegrationRow {
  return {
    kind,
    settings,
    revision: 2,
    createdAt: AT,
    updatedAt: AT,
    updatedBy: { id: "u1", name: "Asha Rao" },
    secrets: Object.entries(secrets).map(([field, value]) => ({
      field,
      ciphertext: sealIntegrationSecret(kind, field, value, key),
      last4: value.length >= 16 ? value.slice(-4) : null,
      updatedAt: AT,
      updatedBy: { id: "u1", name: "Asha Rao" },
    })),
  };
}

const paymentsRow = (keyId = "rzp_live_AbCdEf123456", secrets: Record<string, string> = { keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }) =>
  row("payments", { provider: "razorpay", keyId }, secrets);
const emailRow = (host = "smtp.mailer.example", username: string | null = "mailer") =>
  row("email", { host, port: 587, security: "starttls", username, fromName: "Axiomatic", fromAddress: "no-reply@axiomatic.example" }, { password: "smtp-password" });
const storageRow = (endpoint: string | null = "https://acc123.r2.cloudflarestorage.com") =>
  row("storage", { preset: "r2", endpoint, region: "auto", bucket: "axs-files", accessKeyId: "a1b2c3d4", forcePathStyle: true }, { secretAccessKey: "storage-secret-0001" });

/** A complete env fallback for all three integrations (development rules). */
const ENV = {
  NODE_ENV: "test",
  PAYMENT_PROVIDER: "razorpay",
  PAYMENT_KEY_ID: "rzp_test_EnvKey000001",
  PAYMENT_KEY_SECRET: "env-key-secret-0001",
  PAYMENT_WEBHOOK_SECRET: "env-webhook-secret-0001",
  EMAIL_TRANSPORT: "smtp",
  EMAIL_FROM: "Env <env@axiomatic.example>",
  SMTP_HOST: "smtp.env.example",
  STORAGE_DRIVER: "s3",
  STORAGE_BUCKET: "env-bucket",
  STORAGE_REGION: "ap-south-1",
  STORAGE_ACCESS_KEY_ID: "AKIAENV0001",
  STORAGE_SECRET_ACCESS_KEY: "env-storage-secret",
};

let rows: IntegrationRow[] = [];
const loader = vi.fn(async () => rows);
const logs: string[] = [];

beforeEach(() => {
  rows = [];
  loader.mockClear();
  logs.length = 0;
  integrationSlot().logged.clear();
  setLogSink((_level, line) => logs.push(line));
  setIntegrationKeyForTests(ikm);
  setIntegrationEnvForTests(ENV);
  setIntegrationRowsLoader(loader);
});

afterEach(() => {
  vi.useRealTimers();
  setLogSink(null);
  setIntegrationRowsLoader(async () => []);
  setIntegrationEnvForTests(null);
  setIntegrationKeyForTests(null);
});

describe("precedence (per integration, as a whole)", () => {
  it("uses the env fallback when nothing is saved", async () => {
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.payments).toMatchObject({ source: "env", config: { provider: "razorpay", keyId: ENV.PAYMENT_KEY_ID, mode: "test" } });
    expect(snap.email).toMatchObject({ source: "env", config: { transport: "smtp", host: "smtp.env.example" } });
    expect(snap.storage).toMatchObject({ source: "env", config: { driver: "s3", bucket: "env-bucket", endpoint: null } });
    expect(snap.admin).toEqual({ payments: null, email: null, storage: null });
    expect(snap.env.payments.selector).toBe("razorpay");
  });

  it("lets a saved Admin configuration win, decrypting its secrets, and never mixes in env fields", async () => {
    rows = [paymentsRow(), emailRow("smtp.mailer.example", null), storageRow()];
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.payments).toMatchObject({
      source: "admin",
      config: { provider: "razorpay", keyId: "rzp_live_AbCdEf123456", keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, mode: "live" },
    });
    expect(snap.email).toMatchObject({ source: "admin", config: { host: "smtp.mailer.example", auth: null, from: { name: "Axiomatic", address: "no-reply@axiomatic.example" } } });
    expect(snap.storage).toMatchObject({ source: "admin", config: { endpoint: "https://acc123.r2.cloudflarestorage.com", bucket: "axs-files", secretAccessKey: "storage-secret-0001", preset: "r2" } });
    expect(JSON.stringify(snap.storage)).not.toContain("env-");
    expect(snap.admin.payments).toMatchObject({ revision: 2, updatedByName: "Asha Rao", settings: { keyId: "rzp_live_AbCdEf123456" } });
    expect(snap.admin.payments?.secrets.webhookSecret).toEqual({ last4: "0001", updatedAt: AT, updatedByName: "Asha Rao" });
    expect(JSON.stringify(snap.admin)).not.toContain(KEY_SECRET);
  });

  it("decides 'not configured' for an incomplete, invalid or unreadable saved row: the env file is NOT used", async () => {
    rows = [paymentsRow(undefined, { keySecret: KEY_SECRET }), emailRow("smtp-pending.invalid"), row("storage", { preset: "r2" }, {})];
    let snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.payments).toEqual({ source: "none", reason: "admin_incomplete", names: ["webhookSecret"] });
    expect(snap.email).toEqual({ source: "none", reason: "admin_invalid", names: ["host"] });
    expect(snap.storage).toEqual({ source: "none", reason: "admin_unreadable", names: ["settings"] });
    const otherKey = Buffer.alloc(32, 9);
    rows = [row("payments", { provider: "razorpay", keyId: "rzp_test_1DP5mmOlF5G5ag" }, { keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, otherKey)];
    snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.payments).toEqual({ source: "none", reason: "admin_unreadable", names: ["keySecret"] });
    expect(logs.join("\n")).toContain("integration_secret_unreadable");
    expect(logs.join("\n")).not.toContain(KEY_SECRET);
  });

  it("resolves a saved Amazon SES configuration, opening only the secret SES uses", async () => {
    const ses = { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", configurationSet: "axs-events", fromName: "Axiomatic", fromAddress: "no-reply@axiomatic.example" };
    // A leftover SMTP password sealed under another key would make the row unreadable if it were opened.
    const leftover = row("email", ses, { password: "old-smtp-password" }, Buffer.alloc(32, 9));
    const sesRow = row("email", ses, { secretAccessKey: "ses-secret-access-key-01" });
    rows = [{ ...sesRow, secrets: [...sesRow.secrets, ...leftover.secrets] }];
    setIntegrationEnvForTests({ ...ENV, NODE_ENV: "production" });
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.email).toMatchObject({
      source: "admin",
      config: {
        transport: "ses",
        region: "ap-south-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "ses-secret-access-key-01",
        configurationSet: "axs-events",
        from: { name: "Axiomatic", address: "no-reply@axiomatic.example" },
      },
    });
    expect(logs.join("\n")).not.toContain("integration_secret_unreadable");
    rows = [row("email", ses, {})];
    expect((await getIntegrationSnapshot({ fresh: true })).email).toEqual({ source: "none", reason: "admin_incomplete", names: ["secretAccessKey"] });
    rows = [row("email", { ...ses, region: "mars-1" }, { secretAccessKey: "ses-secret-access-key-01" })];
    expect((await getIntegrationSnapshot({ fresh: true })).email).toEqual({ source: "none", reason: "admin_unreadable", names: ["settings"] });
  });

  it("applies the production host rules to saved settings at resolve time", async () => {
    setIntegrationEnvForTests({ NODE_ENV: "production" });
    rows = [emailRow("127.0.0.1"), storageRow("http://files.example.com")];
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.email).toEqual({ source: "none", reason: "admin_invalid", names: ["host"] });
    expect(snap.storage).toEqual({ source: "none", reason: "admin_invalid", names: ["endpoint"] });
    expect(snap.payments).toEqual({ source: "none", reason: "missing", names: [] });
  });

  it("refuses the env stand-ins and logs their names once, never their values", async () => {
    setIntegrationEnvForTests({ ...ENV, NODE_ENV: "production", PAYMENT_KEY_ID: "rzp_test_pending", SMTP_HOST: "smtp-pending.invalid" });
    await getIntegrationSnapshot({ fresh: true });
    await getIntegrationSnapshot({ fresh: true });
    expect(await resolvePayments()).toEqual({ source: "none", reason: "env_invalid", names: ["PAYMENT_KEY_ID"] });
    expect(await resolveEmail()).toEqual({ source: "none", reason: "env_invalid", names: ["SMTP_HOST"] });
    const ignored = logs.filter((l) => l.includes("integration_env_ignored"));
    expect(ignored.some((l) => l.includes("PAYMENT_KEY_ID"))).toBe(true);
    expect(ignored.join("\n")).not.toMatch(/rzp_test_pending|smtp-pending|env-key-secret/);
  });
});

describe("cache", () => {
  it("serves one snapshot for 30 s, then reloads; concurrent callers share one load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const [a, b] = await Promise.all([getIntegrationSnapshot(), getIntegrationSnapshot()]);
    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS - 1);
    expect(await getIntegrationSnapshot()).toBe(a);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS + 1);
    expect(await getIntegrationSnapshot()).not.toBe(a);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("reloads at once after invalidateIntegrations() (the saving process), and fresh always loads", async () => {
    expect((await resolvePayments()).source).toBe("env");
    rows = [paymentsRow()];
    expect((await resolvePayments()).source).toBe("env"); // cached
    invalidateIntegrations();
    expect((await resolvePayments()).source).toBe("admin");
    rows = [];
    expect((await getIntegrationSnapshot({ fresh: true })).payments.source).toBe("env");
    expect((await resolvePayments()).source).toBe("env"); // the fresh load was stored
  });

  it("does not store a load that started before an invalidation", async () => {
    let release: () => void = () => undefined;
    loader.mockImplementationOnce(() => new Promise<IntegrationRow[]>((resolve) => (release = () => resolve([]))));
    const early = getIntegrationSnapshot();
    await Promise.resolve();
    rows = [paymentsRow()];
    invalidateIntegrations();
    const late = await getIntegrationSnapshot();
    expect(late.payments.source).toBe("admin");
    release();
    expect((await early).payments.source).toBe("env"); // its own caller still gets an answer
    expect((await getIntegrationSnapshot()).payments.source).toBe("admin"); // but it was not stored
  });

  it("keeps the last good snapshot when a reload fails, and backs off for 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const good = await getIntegrationSnapshot();
    loader.mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS + 1);
    expect(await getIntegrationSnapshot()).toBe(good); // the reload fails: the last good snapshot answers
    expect(await getIntegrationSnapshot()).toBe(good); // and keeps answering while backing off
    const calls = loader.mock.calls.length;
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS + 4_000);
    expect(await getIntegrationSnapshot()).toBe(good);
    expect(loader.mock.calls.length).toBe(calls);
    expect(logs.filter((l) => l.includes("integration_load_failed"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("ECONNREFUSED");
    loader.mockImplementation(async () => rows);
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS + 6_000);
    expect(await getIntegrationSnapshot()).not.toBe(good);
  });

  it("propagates the error when no snapshot exists at all", async () => {
    loader.mockRejectedValueOnce(new Error("database is down"));
    await expect(getIntegrationSnapshot()).rejects.toThrow("database is down");
  });

  it("allowStale answers from an expired snapshot at once and refreshes in the background", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const first = await getIntegrationSnapshot();
    rows = [storageRow()];
    vi.setSystemTime(AT.getTime() + INTEGRATION_CACHE_TTL_MS + 1);
    const stale = await getIntegrationSnapshot({ allowStale: true, maxWaitMs: 1_000 });
    expect(stale).toBe(first);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await getIntegrationSnapshot()).storage.source).toBe("admin"));
  });

  it("allowStale waits at most maxWaitMs for a cold start", async () => {
    loader.mockImplementationOnce(() => new Promise<IntegrationRow[]>(() => undefined));
    await expect(getIntegrationSnapshot({ allowStale: true, maxWaitMs: 20 })).rejects.toThrow("still loading");
  });

  it("shares one snapshot and one invalidation across module copies (globalThis slot)", async () => {
    const snap = await getIntegrationSnapshot();
    vi.resetModules();
    const other = await import("@/lib/integrations/resolver");
    expect(await other.getIntegrationSnapshot()).toBe(snap);
    other.invalidateIntegrations();
    expect(await getIntegrationSnapshot()).not.toBe(snap);
  });

  it("changes a fingerprint only when the configuration changes", async () => {
    const fp = async () => {
      const r = await resolveStorage({ fresh: true });
      return r.source === "none" ? null : r.fingerprint;
    };
    rows = [storageRow()];
    const a = await fp();
    expect(await fp()).toBe(a);
    rows = [storageRow("https://acc999.r2.cloudflarestorage.com")];
    const b = await fp();
    expect(b).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    rows = [];
    expect(await fp()).not.toBe(a); // the env fallback is another configuration
  });
});
