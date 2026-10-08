/**
 * Admin > Settings > Integrations routes (app/api/admin/settings/integrations/**; docs/admin-integrations-design.md
 * sections 13 to 16): Owner only (integrations.manage) with CSRF and same-origin, password re-entry with its rate limit,
 * secrets encrypted at rest and never in a response, audit row or log line, keep-on-empty, stale revisions, the
 * production host rules, clear and remove, immediate invalidation in the saving process, and the test buttons.
 *
 * Every test deletes the IntegrationConfig rows it created (by kind), resets the Owner's integration rate-limit buckets
 * and invalidates the resolver cache. The env fallback is injected (setIntegrationEnvForTests), so .env.local does not
 * matter.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as integrationDELETE, PUT as integrationPUT } from "@/app/api/admin/settings/integrations/[kind]/route";
import { DELETE as secretDELETE } from "@/app/api/admin/settings/integrations/[kind]/secrets/[field]/route";
import { POST as testPOST } from "@/app/api/admin/settings/integrations/[kind]/test/route";
import { GET as settingsGET } from "@/app/api/admin/settings/route";
import { saveIntegration, setIntegrationProbeClientsForTests, type IntegrationCaller } from "@/lib/admin/settings/integration-actions";
import type { IntegrationState } from "@/lib/admin/settings/integrations-model";
import type { AdminSettingsData } from "@/lib/admin/settings/model";
import { actorFromStaff } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type { OutgoingEmail } from "@/lib/email/transport";
import { createSesTransport } from "@/lib/email/transports/ses";
import { getEnv, getLicenseKeySecrets } from "@/lib/env";
import { openIntegrationSecret } from "@/lib/integrations/crypto";
import { emailSaveSchema, INTEGRATION_KINDS, storageSaveSchema, toDbKind } from "@/lib/integrations/model";
import { invalidateIntegrations, resolveEmail, resolvePayments, resolveStorage, setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import type { EmailConfig, ProbeResult } from "@/lib/integrations/types";
import { setLogSink } from "@/lib/log";
import { LocalStorageDriver } from "@/lib/storage/local";
import { callRoute, makeAdminCallers, makeStaff, startSession, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

const PASSWORD = "Owner-pass-2026!";
const KEY_ID = "rzp_test_RouteTest0001";
const KEY_SECRET = "route-key-secret-0001";
const KEY_SECRET_2 = "route-key-secret-0002";
const WEBHOOK_SECRET = "route-webhook-secret-0001";
const SMTP_PASSWORD = "route-smtp-password-01";
const STORAGE_SECRET = "route-storage-secret-0001";
const SES_SECRET = "route-ses-secret-access-key-0001";
const SES_SECRET_2 = "route-ses-secret-access-key-0002";
const KNOWN_SECRETS = [KEY_SECRET, KEY_SECRET_2, WEBHOOK_SECRET, SMTP_PASSWORD, STORAGE_SECRET, SES_SECRET, SES_SECRET_2, PASSWORD];

/** A complete env fallback for every integration (development rules), with its own secrets. */
const ENV = {
  NODE_ENV: "test",
  PAYMENT_PROVIDER: "razorpay",
  PAYMENT_KEY_ID: "rzp_test_EnvRoute00001",
  PAYMENT_KEY_SECRET: "env-route-key-secret",
  PAYMENT_WEBHOOK_SECRET: "env-route-webhook-secret",
  EMAIL_TRANSPORT: "smtp",
  EMAIL_FROM: "Env <env@axiomatic.example>",
  SMTP_HOST: "smtp.env.example",
  STORAGE_DRIVER: "s3",
  STORAGE_BUCKET: "env-bucket",
  STORAGE_REGION: "ap-south-1",
  STORAGE_ACCESS_KEY_ID: "AKIAENVROUTE",
  STORAGE_SECRET_ACCESS_KEY: "env-route-storage-secret",
};
const ENV_SECRETS = [ENV.PAYMENT_KEY_SECRET, ENV.PAYMENT_WEBHOOK_SECRET, ENV.STORAGE_SECRET_ACCESS_KEY];

let owner: TestSession;
let dir = "";
let logs: string[] = [];
/** Every response body of this test file's calls (checked for secrets after each test). */
const seen: string[] = [];
const ikm = () => getLicenseKeySecrets().encKey;

beforeAll(async () => {
  const user = await makeStaff("OWNER", { name: "Asha Rao" });
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  owner = await startSession(user);
  dir = await mkdtemp(path.join(tmpdir(), "axs-integrations-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  logs = [];
  seen.length = 0;
  setLogSink((_level, line) => logs.push(line));
  setIntegrationEnvForTests(ENV);
});
afterEach(async () => {
  // No secret, env secret or ciphertext in any response, log line or audit row of this test.
  const ciphertexts = (await db.integrationSecret.findMany({ select: { ciphertext: true } })).map((s) => s.ciphertext);
  const audits = JSON.stringify(await db.auditLog.findMany({ where: { actorId: owner.user.id } }));
  for (const needle of [...KNOWN_SECRETS, ...ENV_SECRETS, ...ciphertexts]) {
    for (const hay of [...seen, ...logs, audits]) expect(hay.includes(needle), "a secret leaked").toBe(false);
  }
  await db.integrationConfig.deleteMany({ where: { kind: { in: INTEGRATION_KINDS.map(toDbKind) } } });
  await clear(db, RATE_LIMITS.integrationPassword(owner.user.id).key);
  await clear(db, RATE_LIMITS.integrationTest(owner.user.id).key);
  setIntegrationEnvForTests(null);
  setIntegrationProbeClientsForTests(null);
  setLogSink(null);
  invalidateIntegrations();
});

type Json = Record<string, unknown>;
type Session = TestSession | null;
const BASE = "/api/admin/settings/integrations";

async function read<T = Json>(res: Response): Promise<{ status: number; code: string | null; body: T }> {
  const text = await res.text();
  seen.push(text);
  const body = (text ? JSON.parse(text) : {}) as T;
  const code = (body as { error?: { code?: string } }).error?.code ?? null;
  return { status: res.status, code, body };
}
const fieldErrorsOf = (body: unknown) => (body as { error: { fieldErrors: Record<string, string[]> } }).error.fieldErrors;

const put = (kind: string, body: unknown, session: Session = owner, extra: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) =>
  callRoute(jar, integrationPUT, { method: "PUT", path: `${BASE}/${kind}`, params: { kind }, body, session, ...extra });
const remove = (kind: string, body: unknown = { currentPassword: PASSWORD }, session: Session = owner) =>
  callRoute(jar, integrationDELETE, { method: "DELETE", path: `${BASE}/${kind}`, params: { kind }, body, session });
const clearSecret = (kind: string, field: string, body: unknown = { currentPassword: PASSWORD }, session: Session = owner) =>
  callRoute(jar, secretDELETE, { method: "DELETE", path: `${BASE}/${kind}/secrets/${field}`, params: { kind, field }, body, session });
const probe = (kind: string, session: Session = owner, body: unknown = {}) =>
  callRoute(jar, testPOST, { method: "POST", path: `${BASE}/${kind}/test`, params: { kind }, body, session });

const paymentsBody = (over: Json = {}) => ({ currentPassword: PASSWORD, revision: null, keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, ...over });
const emailBody = (over: Json = {}) => ({
  currentPassword: PASSWORD,
  revision: null,
  host: "smtp.mailer.example",
  port: 587,
  security: "starttls",
  username: "mailer",
  password: SMTP_PASSWORD,
  fromName: "Axiomatic",
  fromAddress: "no-reply@axiomatic.example",
  ...over,
});
const sesBody = (over: Json = {}) => ({
  currentPassword: PASSWORD,
  revision: null,
  provider: "ses",
  region: "ap-south-1",
  accessKeyId: "AKIAROUTETEST0000001",
  secretAccessKey: SES_SECRET,
  configurationSet: "",
  fromName: "Axiomatic",
  fromAddress: "no-reply@axiomatic.example",
  ...over,
});
const storageBody = (over: Json = {}) => ({
  currentPassword: PASSWORD,
  revision: null,
  preset: "r2",
  endpoint: "https://acc123.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "axs-route-test",
  accessKeyId: "a1b2c3d4e5",
  secretAccessKey: STORAGE_SECRET,
  forcePathStyle: true,
  ...over,
});
/** The ids of the Owner's audit rows so far: auditSince() leaves out rows of earlier tests. */
const auditMark = async () => (await db.auditLog.findMany({ where: { actorId: owner.user.id }, select: { id: true } })).map((r) => r.id);
const auditSince = (mark: string[]) =>
  db.auditLog.findMany({ where: { actorId: owner.user.id, targetType: "settings", id: { notIn: mark } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("access", () => {
  it("is Owner only: other staff and customers get 403, signed-out callers 401, on every integration route", async () => {
    const callers = await makeAdminCallers();
    const sends: ((s: Session) => Promise<Response>)[] = [
      (s) => put("payments", paymentsBody(), s),
      (s) => remove("payments", { currentPassword: PASSWORD }, s),
      (s) => clearSecret("payments", "keySecret", { currentPassword: PASSWORD }, s),
      (s) => probe("payments", s),
    ];
    for (const send of sends) {
      const signedOut = await read(await send(null));
      expect([signedOut.status, signedOut.code]).toEqual([401, "unauthorized"]);
      for (const who of [callers.customer, callers.ADMIN, callers.SUPPORT, callers.FINANCE]) {
        const res = await read(await send(who));
        expect([res.status, res.code]).toEqual([403, "forbidden"]);
      }
    }
    // The settings page data stays Owner only too.
    for (const who of [callers.ADMIN, callers.SUPPORT, callers.FINANCE]) {
      expect((await callRoute(jar, settingsGET, { path: "/api/admin/settings", session: who })).status).toBe(403);
    }
    expect(await db.integrationConfig.count()).toBe(0);
  });

  it("refuses a missing CSRF token, another origin and cross-site requests, and unknown kinds or fields", async () => {
    expect((await read(await put("payments", paymentsBody(), owner, { csrf: false }))).status).toBe(403);
    expect((await read(await put("payments", paymentsBody(), owner, { origin: "https://evil.example" }))).status).toBe(403);
    const cross = await read(await put("payments", paymentsBody(), owner, { headers: { "sec-fetch-site": "cross-site" } }));
    expect([cross.status, cross.code]).toEqual([403, "forbidden"]);
    expect((await read(await put("cashfree", paymentsBody()))).status).toBe(404);
    expect((await read(await clearSecret("payments", "keyId"))).status).toBe(404);
    expect((await read(await clearSecret("email", "keySecret"))).status).toBe(404);
    expect((await read(await probe("redis"))).status).toBe(404);
    expect(await db.integrationConfig.count()).toBe(0);
  });
});

describe("PUT /api/admin/settings/integrations/:kind", () => {
  it("saves with the Owner's password: encrypted at rest, hints only in responses, audited by label, used at once", async () => {
    expect(await resolvePayments()).toMatchObject({ source: "env" }); // cached from the env file
    const since = await auditMark();
    const res = await read<{ integration: IntegrationState; changed: string[] }>(await put("payments", paymentsBody()));
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["keyId", "keySecret", "webhookSecret"]);
    expect(res.body.integration).toMatchObject({ id: "payments", source: "admin", mode: "test", problem: null, saved: { revision: 1, updatedBy: "Asha Rao" } });
    expect(res.body.integration.form).toMatchObject({
      prefilledFrom: "admin",
      values: { keyId: KEY_ID },
      secrets: { keySecret: { set: true, last4: "0001", updatedBy: "Asha Rao" }, webhookSecret: { set: true, last4: "0001", updatedBy: "Asha Rao" } },
    });
    const stored = await db.integrationSecret.findMany({ where: { kind: "PAYMENTS" }, orderBy: { field: "asc" } });
    expect(stored.map((s) => [s.field, openIntegrationSecret("payments", s.field, s.ciphertext, ikm())])).toEqual([
      ["keySecret", KEY_SECRET],
      ["webhookSecret", WEBHOOK_SECRET],
    ]);
    // Invalidated in this process: the cached env answer is gone without waiting 30 s.
    expect(await resolvePayments()).toMatchObject({ source: "admin", config: { keyId: KEY_ID, keySecret: KEY_SECRET, mode: "test" } });
    const rows = await auditSince(since);
    expect(rows.map((r) => [r.action, r.target, r.targetId, r.detail])).toEqual([
      ["Updated integration settings", "Integrations · Payment provider", "integrations.payments", "Saved: Key ID, Key secret, Webhook secret (replaces the server file)."],
    ]);
    expect(logs.some((l) => l.includes('"event":"integration_saved"'))).toBe(true);

    const page = await read<AdminSettingsData>(await callRoute(jar, settingsGET, { path: "/api/admin/settings", session: owner }));
    const payments = page.body.integrations.items.find((i) => i.id === "payments");
    expect(payments).toMatchObject({ source: "admin", form: { secrets: { keySecret: { set: true, last4: "0001" } } } });
  });

  it("re-checks the password: a wrong one is 422 on currentPassword and saves nothing; the 6th try is 429", async () => {
    const mark = await auditMark();
    for (let i = 0; i < 4; i += 1) {
      const wrong = await read(await put("payments", paymentsBody({ currentPassword: "not-the-password" })));
      expect([wrong.status, wrong.code, fieldErrorsOf(wrong.body)]).toEqual([422, "incorrect_password", { currentPassword: ["Incorrect password."] }]);
    }
    expect(await db.integrationConfig.count()).toBe(0);
    expect(logs.filter((l) => l.includes('"event":"integration_password_denied"'))).toHaveLength(4);
    // A success clears the count.
    expect((await read(await put("payments", paymentsBody()))).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await read(await remove("payments", { currentPassword: "nope" }))).status).toBe(422);
    const limited = await read(await remove("payments"));
    expect([limited.status, limited.code]).toEqual([429, "too_many_attempts"]);
    expect(await db.integrationConfig.count({ where: { kind: "PAYMENTS" } })).toBe(1);
    // A body that fails validation is refused before the password is counted or checked.
    await clear(db, RATE_LIMITS.integrationPassword(owner.user.id).key);
    const invalid = await read(await put("payments", { ...paymentsBody(), keyId: "rzp_test_pending", extra: 1 }));
    expect([invalid.status, invalid.code]).toEqual([422, "validation_failed"]);
    // Refused passwords are logged, never audited.
    expect((await auditSince(mark)).map((r) => r.action)).toEqual(["Updated integration settings"]);
  });

  it("keeps a stored secret when the field is empty, replaces it when one is entered, refuses stale revisions and missing secrets", async () => {
    const missing = await read(await put("payments", paymentsBody({ webhookSecret: undefined })));
    expect([missing.status, fieldErrorsOf(missing.body)]).toEqual([422, { webhookSecret: ["Enter the webhook secret."] }]);
    expect(await db.integrationConfig.count()).toBe(0);
    expect((await read(await put("payments", paymentsBody()))).status).toBe(200);
    const before = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });

    const kept = await read<{ integration: IntegrationState; changed: string[] }>(
      await put("payments", paymentsBody({ revision: 1, keyId: "rzp_test_RouteTest0002", keySecret: "", webhookSecret: undefined })),
    );
    expect([kept.status, kept.body.changed, kept.body.integration.saved?.revision]).toEqual([200, ["keyId"], 2]);
    const after = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    expect(after.ciphertext).toBe(before.ciphertext);

    const replaced = await read<{ integration: IntegrationState; changed: string[] }>(
      await put("payments", paymentsBody({ revision: 2, keyId: "rzp_test_RouteTest0002", keySecret: KEY_SECRET_2, webhookSecret: undefined })),
    );
    expect(replaced.body.changed).toEqual(["keySecret"]);
    expect(replaced.body.integration.form).toMatchObject({ secrets: { keySecret: { set: true, last4: "0002" } } });
    const latest = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    expect(openIntegrationSecret("payments", "keySecret", latest.ciphertext, ikm())).toBe(KEY_SECRET_2);
    for (const hay of [...seen, ...logs]) expect(hay.includes(before.ciphertext)).toBe(false);

    const stale = await read(await put("payments", paymentsBody({ revision: 1 })));
    expect([stale.status, stale.code]).toEqual([409, "integration_changed"]);
    const since = await auditMark();
    const same = await read<{ changed: string[] }>(await put("payments", paymentsBody({ revision: 3, keyId: "rzp_test_RouteTest0002", keySecret: undefined, webhookSecret: undefined })));
    expect([same.status, same.body.changed]).toEqual([200, []]);
    expect(await auditSince(since)).toEqual([]);
  });

  it("in production refuses private or unknown hosts and plain-http endpoints at save time (service options)", async () => {
    const by: IntegrationCaller = {
      staff: { id: owner.user.id, name: owner.user.name, email: owner.user.email, role: "OWNER" },
      actor: actorFromStaff({ id: owner.user.id, staffRole: "OWNER" }),
    };
    const lookup = vi.fn(async (host: string) => {
      if (host === "smtp.private.example") return [{ address: "203.0.113.7", family: 4 }, { address: "10.0.0.5", family: 4 }];
      if (host === "smtp.public.example" || host === "acc123.r2.cloudflarestorage.com") return [{ address: "203.0.113.10", family: 4 }];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    const failure = async (promise: Promise<unknown>) => {
      const e = (await promise.then(() => null, (err: unknown) => err)) as { status: number; code: string; details: { fieldErrors: Record<string, string[]> } };
      return [e.status, e.code, e.details.fieldErrors];
    };
    const email = (host: string) => emailSaveSchema.parse(emailBody({ host }));
    const opts = { production: true, lookup };
    expect(await failure(saveIntegration(by, "email", email("smtp.private.example"), opts))).toEqual([422, "validation_failed", { host: ["This host points to a private network address."] }]);
    expect(await failure(saveIntegration(by, "email", email("smtp.missing.example"), opts))).toEqual([422, "validation_failed", { host: ["We couldn’t find this host."] }]);
    expect(await failure(saveIntegration(by, "email", email("127.0.0.1"), opts))).toEqual([422, "validation_failed", { host: ["This host points to a private network address."] }]);
    expect(await failure(saveIntegration(by, "email", email("localhost"), opts))).toEqual([422, "validation_failed", { host: ["Use a public host name, not a local one."] }]);
    const storage = (endpoint: string) => storageSaveSchema.parse(storageBody({ endpoint }));
    expect(await failure(saveIntegration(by, "storage", storage("http://acc123.r2.cloudflarestorage.com"), opts))).toEqual([422, "validation_failed", { endpoint: ["Use an https:// address."] }]);
    expect(await failure(saveIntegration(by, "storage", storage("https://169.254.169.254"), opts))).toEqual([422, "validation_failed", { endpoint: ["This host points to a private network address."] }]);
    expect(await db.integrationConfig.count()).toBe(0);
    // Public hosts pass; development allows local test servers without a lookup.
    expect((await saveIntegration(by, "email", email("smtp.public.example"), opts)).integration.source).toBe("admin");
    expect((await saveIntegration(by, "storage", storage("https://acc123.r2.cloudflarestorage.com"), opts)).integration.source).toBe("admin");
    lookup.mockClear();
    // A new SMTP host needs the saved password entered again (here it is).
    const dev = await saveIntegration(by, "email", { ...email("localhost"), revision: 1 }, { production: false, lookup });
    expect([dev.changed, lookup.mock.calls.length]).toEqual([["host", "password"], 0]);
  });

  it("never sends a kept secret to a new server: changing the SMTP server or the endpoint needs the secret again", async () => {
    expect((await read(await put("email", emailBody()))).status).toBe(200);
    const sealed = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "EMAIL", field: "password" } } });
    for (const change of [{ host: "smtp.attacker.example" }, { port: 2525 }, { security: "tls", port: 465 }]) {
      const moved = await read(await put("email", emailBody({ revision: 1, password: undefined, ...change })));
      expect([moved.status, fieldErrorsOf(moved.body)]).toEqual([422, { password: ["Enter it again: the email provider, server or region changed."] }]);
    }
    // Leaving it empty while only the sender changes still keeps it.
    const kept = await read<{ changed: string[] }>(await put("email", emailBody({ revision: 1, password: undefined, fromName: "Axiomatic Software" })));
    expect([kept.status, kept.body.changed]).toEqual([200, ["fromName"]]);
    const still = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "EMAIL", field: "password" } } });
    expect(still.ciphertext).toBe(sealed.ciphertext);
    expect((await read(await put("email", emailBody({ revision: 2, host: "SMTP.Mailer.Example", password: undefined, fromName: "Axiomatic Software" })))).status).toBe(200);
    const moved = await read<{ changed: string[] }>(await put("email", emailBody({ revision: 2, host: "smtp.new-provider.example", fromName: "Axiomatic Software" })));
    expect([moved.status, moved.body.changed]).toEqual([200, ["host", "password"]]);

    expect((await read(await put("storage", storageBody()))).status).toBe(200);
    const endpoint = await read(await put("storage", storageBody({ revision: 1, secretAccessKey: undefined, endpoint: "https://acc999.r2.cloudflarestorage.com" })));
    expect([endpoint.status, fieldErrorsOf(endpoint.body)]).toEqual([422, { secretAccessKey: ["Enter it again: the endpoint changed."] }]);
    const bucket = await read<{ changed: string[] }>(await put("storage", storageBody({ revision: 1, secretAccessKey: undefined, bucket: "axs-route-test-2" })));
    expect([bucket.status, bucket.body.changed]).toEqual([200, ["bucket"]]);
  });
});

describe("Amazon SES (email provider)", () => {
  const emailSecrets = async () => (await db.integrationSecret.findMany({ where: { kind: "EMAIL" }, select: { field: true }, orderBy: { field: "asc" } })).map((s) => s.field);

  it("saves an SES configuration as the Owner only: encrypted at rest, hints only, audited by label, used at once", async () => {
    const callers = await makeAdminCallers();
    for (const who of [callers.ADMIN, callers.SUPPORT, callers.FINANCE, callers.customer]) {
      expect((await read(await put("email", sesBody(), who))).status).toBe(403);
    }
    expect(await db.integrationConfig.count()).toBe(0);
    expect(await resolveEmail()).toMatchObject({ source: "env", config: { transport: "smtp" } });
    const since = await auditMark();
    const res = await read<{ integration: IntegrationState; changed: string[] }>(await put("email", sesBody({ region: " AP-SOUTH-1 " })));
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["region", "accessKeyId", "configurationSet", "fromName", "fromAddress", "secretAccessKey"]);
    expect(res.body.integration).toMatchObject({ id: "email", source: "admin", provider: "Amazon SES (API)", problem: null, saved: { revision: 1 } });
    expect(res.body.integration.form).toMatchObject({
      values: { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAROUTETEST0000001", configurationSet: "" },
      secrets: { secretAccessKey: { set: true, last4: "0001", updatedBy: "Asha Rao" }, password: { set: false } },
    });
    const config = await db.integrationConfig.findUniqueOrThrow({ where: { kind: "EMAIL" }, include: { secrets: true } });
    expect(config.settings).toEqual({ provider: "ses", region: "ap-south-1", accessKeyId: "AKIAROUTETEST0000001", configurationSet: null, fromName: "Axiomatic", fromAddress: "no-reply@axiomatic.example" });
    expect(config.secrets.map((s) => [s.field, openIntegrationSecret("email", s.field, s.ciphertext, ikm())])).toEqual([["secretAccessKey", SES_SECRET]]);
    expect(await resolveEmail()).toMatchObject({ source: "admin", config: { transport: "ses", region: "ap-south-1", secretAccessKey: SES_SECRET, configurationSet: null } });
    expect((await auditSince(since)).map((r) => [r.action, r.target, r.detail])).toEqual([
      ["Updated integration settings", "Integrations · Email delivery", "Saved: AWS region, Access key ID, Configuration set, From name, From address, Secret access key (replaces the server file)."],
    ]);
    // Invalid SES bodies are refused before the password is checked.
    const bad = await read(await put("email", sesBody({ region: "ap-south-9", accessKeyId: "nope", configurationSet: "bad set", currentPassword: "wrong" })));
    expect([bad.status, Object.keys(fieldErrorsOf(bad.body)).sort()]).toEqual([422, ["accessKeyId", "configurationSet", "region"]]);
  });

  it("switching provider needs the new secret, removes the other one, and a new region needs the secret again", async () => {
    expect((await read(await put("email", emailBody()))).status).toBe(200);
    expect(await emailSecrets()).toEqual(["password"]);
    const since = await auditMark();
    const noSecret = await read(await put("email", sesBody({ revision: 1, secretAccessKey: undefined })));
    expect([noSecret.status, fieldErrorsOf(noSecret.body)]).toEqual([422, { secretAccessKey: ["Enter the secret access key."] }]);
    const switched = await read<{ integration: IntegrationState; changed: string[] }>(await put("email", sesBody({ revision: 1 })));
    expect([switched.status, switched.body.changed]).toEqual([200, ["provider", "region", "accessKeyId", "secretAccessKey"]]);
    expect(switched.body.integration.form).toMatchObject({ secrets: { password: { set: false }, secretAccessKey: { set: true } } });
    // The SMTP password is gone with the switch: it can never be sent to SES or come back unseen.
    expect(await emailSecrets()).toEqual(["secretAccessKey"]);
    expect((await read(await put("email", { ...sesBody({ revision: 2 }), password: SMTP_PASSWORD }))).status).toBe(422);

    const moved = await read(await put("email", sesBody({ revision: 2, secretAccessKey: undefined, region: "eu-west-1" })));
    expect([moved.status, fieldErrorsOf(moved.body)]).toEqual([422, { secretAccessKey: ["Enter it again: the email provider, server or region changed."] }]);
    const kept = await read<{ changed: string[] }>(
      await put("email", sesBody({ revision: 2, secretAccessKey: undefined, accessKeyId: "AKIAROUTETEST0000002", configurationSet: "axs-events" })),
    );
    expect([kept.status, kept.body.changed]).toEqual([200, ["accessKeyId", "configurationSet"]]);
    const regionMoved = await read<{ changed: string[] }>(
      await put("email", sesBody({ revision: 3, accessKeyId: "AKIAROUTETEST0000002", configurationSet: "axs-events", region: "eu-west-1", secretAccessKey: SES_SECRET_2 })),
    );
    expect([regionMoved.status, regionMoved.body.changed]).toEqual([200, ["region", "secretAccessKey"]]);
    expect(await resolveEmail()).toMatchObject({ source: "admin", config: { transport: "ses", region: "eu-west-1", secretAccessKey: SES_SECRET_2, configurationSet: "axs-events" } });

    // Back to SMTP: the password was removed, so it must be entered; the SES key goes.
    const back = await read(await put("email", emailBody({ revision: 4, password: undefined })));
    expect([back.status, fieldErrorsOf(back.body)]).toEqual([422, { password: ["Enter the password."] }]);
    expect((await read(await put("email", emailBody({ revision: 4 })))).status).toBe(200);
    expect(await emailSecrets()).toEqual(["password"]);
    expect((await auditSince(since)).map((r) => r.detail)).toEqual([
      "Changed: Provider, AWS region, Access key ID, Secret access key. Removed: Password.",
      "Changed: Access key ID, Configuration set.",
      "Changed: AWS region, Secret access key.",
      "Changed: Provider, SMTP host, Port, Security, Username, Password. Removed: Secret access key.",
    ]);
  });

  it("in production an SES save needs no host lookup (the AWS endpoint follows the region)", async () => {
    const by: IntegrationCaller = {
      staff: { id: owner.user.id, name: owner.user.name, email: owner.user.email, role: "OWNER" },
      actor: actorFromStaff({ id: owner.user.id, staffRole: "OWNER" }),
    };
    const lookup = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    const saved = await saveIntegration(by, "email", emailSaveSchema.parse(sesBody()), { production: true, lookup });
    expect([saved.integration.source, saved.integration.provider, lookup.mock.calls.length]).toEqual(["admin", "Amazon SES (API)", 0]);
  });

  it("Send test email goes through SES with a mocked client to the Owner; AWS errors are mapped and audited", async () => {
    expect((await read(await put("email", sesBody()))).status).toBe(200);
    const sent: unknown[] = [];
    const state: { failure: unknown } = { failure: null };
    const client = {
      send: async (command: unknown) => {
        sent.push((command as { input: unknown }).input);
        if (state.failure) throw state.failure;
        return { MessageId: "ses-probe-1" };
      },
      destroy: () => undefined,
    };
    setIntegrationProbeClientsForTests({ transportFactory: async (config: EmailConfig) => createSesTransport(config as Extract<EmailConfig, { transport: "ses" }>, client) });
    const since = await auditMark();
    const results: ProbeResult[] = [];
    const run = async () => {
      const res = await read<ProbeResult>(await probe("email"));
      expect(res.status).toBe(200);
      results.push(res.body);
      return res.body;
    };
    expect(await run()).toMatchObject({ kind: "email", source: "admin", ok: true, steps: [{ id: "send", status: "ok", message: `Sent to ${owner.user.email}. Check that inbox (and spam).` }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ Destination: { ToAddresses: [owner.user.email] } });
    const awsError = (name: string, status: number, message: string) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
    state.failure = awsError("AccessDeniedException", 403, "User: arn:aws:iam::123456789012:user/axs is not authorized to perform ses:SendRawEmail");
    expect((await run()).steps[0]?.message).toBe("This access key isn’t allowed to send email. Allow ses:SendEmail and ses:SendRawEmail.");
    state.failure = awsError("InvalidClientTokenId", 403, "The security token included in the request is invalid.");
    expect((await run()).steps[0]?.message).toBe("AWS rejected the access key ID or secret access key.");
    state.failure = awsError("MessageRejected", 400, `Email address is not verified: ${owner.user.email}`);
    expect((await run()).steps[0]?.message).toContain("Amazon SES refused the message");
    const rows = (await auditSince(since)).filter((r) => r.action === "Tested integration");
    expect(rows.map((r) => r.detail)).toEqual([
      "Send test email: sent.",
      "Send test email: failed (missing permission).",
      "Send test email: failed (keys rejected).",
      "Send test email: failed (sender or recipient not verified).",
    ]);
    const text = JSON.stringify([results, rows.map((r) => r.detail)]);
    for (const value of ["123456789012", "AKIAROUTETEST", "security token", "not verified:"]) expect(text.includes(value), value).toBe(false);
  });
});

describe("clear and remove", () => {
  it("clearing a required secret stops the integration (never the server file); removing brings the server file back", async () => {
    expect(await resolveStorage()).toMatchObject({ source: "env", config: { bucket: "env-bucket" } });
    const since = await auditMark();
    expect((await read(await put("storage", storageBody()))).status).toBe(200);
    const notSaved = await read(await clearSecret("email", "password"));
    expect([notSaved.status, notSaved.code]).toEqual([409, "integration_not_saved"]);

    const cleared = await read<{ integration: IntegrationState; cleared: boolean }>(await clearSecret("storage", "secretAccessKey"));
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(true);
    expect(cleared.body.integration).toMatchObject({
      source: "none",
      problem: "Secret access key was cleared. Enter a new one to turn this back on.",
      saved: { revision: 2 },
      form: { secrets: { secretAccessKey: { set: false } } },
    });
    expect(await resolveStorage()).toEqual({ source: "none", reason: "admin_incomplete", names: ["secretAccessKey"] });
    const again = await read<{ cleared: boolean }>(await clearSecret("storage", "secretAccessKey"));
    expect([again.status, again.body.cleared]).toEqual([200, false]);
    const wrong = await read(await clearSecret("storage", "secretAccessKey", { currentPassword: "nope" }));
    expect([wrong.status, wrong.code]).toEqual([422, "incorrect_password"]);

    const removed = await read<{ integration: IntegrationState }>(await remove("storage"));
    expect(removed.status).toBe(200);
    expect(removed.body.integration).toMatchObject({ source: "env", saved: null, form: { prefilledFrom: "env", values: { bucket: "env-bucket" } } });
    expect(await resolveStorage()).toMatchObject({ source: "env", config: { bucket: "env-bucket" } });
    const gone = await read(await remove("storage"));
    expect([gone.status, gone.code]).toEqual([409, "integration_not_saved"]);
    expect(await db.integrationSecret.count({ where: { kind: "STORAGE" } })).toBe(0);

    const rows = await auditSince(since);
    expect(rows.map((r) => [r.action, r.target, r.detail])).toEqual([
      ["Updated integration settings", "Integrations · Installer storage", "Saved: Provider, Endpoint, Region, Bucket, Access key ID, Path-style URLs, Secret access key (replaces the server file)."],
      ["Cleared integration secret", "Integrations · Installer storage", "Cleared: Secret access key. Uploads and downloads are off until a new one is saved."],
      ["Removed integration settings", "Integrations · Installer storage", "Now using the server file."],
    ]);
  });

  it("an optional secret is cleared without stopping email; removing without a usable server file says so", async () => {
    setIntegrationEnvForTests({ NODE_ENV: "production" });
    const since = await auditMark();
    const saved = await read<{ integration: IntegrationState }>(await put("email", emailBody({ username: "" })));
    expect(saved.body.integration).toMatchObject({ source: "admin", form: { values: { username: "" }, secrets: { password: { set: true, last4: "d-01" } } } });
    const cleared = await read<{ integration: IntegrationState; cleared: boolean }>(await clearSecret("email", "password"));
    expect([cleared.body.cleared, cleared.body.integration.source]).toEqual([true, "admin"]);
    const removed = await read<{ integration: IntegrationState }>(await remove("email"));
    expect(removed.body.integration).toMatchObject({ source: "none", problem: "Not set up yet." });
    expect((await auditSince(since)).map((r) => r.detail)).toEqual([
      "Saved: SMTP host, Port, Security, Username, From name, From address, Password.",
      "Cleared: Password.",
      "Now not configured.",
    ]);
  });
});

describe("POST /api/admin/settings/integrations/:kind/test", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("tests the effective configuration with one-off clients and audits the outcome without addresses", async () => {
    const sent: OutgoingEmail[] = [];
    setIntegrationProbeClientsForTests({
      fetch: async () => json(200, { entity: "collection", count: 0, items: [] }),
      transportFactory: async () => ({
        name: "test",
        send: async (message: OutgoingEmail) => {
          sent.push(message);
          return { messageId: "probe-1" };
        },
      }),
      driverFactory: () => new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET }),
    });
    const since = await auditMark();
    const payments = await read<ProbeResult>(await probe("payments"));
    expect(payments.status).toBe(200);
    expect(payments.body).toMatchObject({ kind: "payments", source: "env", ok: true });
    expect(payments.body.steps[0]).toEqual({ id: "keys", label: "Keys", status: "ok", message: "Razorpay accepted the keys (test mode)." });

    const email = await read<ProbeResult>(await probe("email"));
    expect(email.body).toMatchObject({ kind: "email", ok: true, steps: [{ id: "send", status: "ok", message: `Sent to ${owner.user.email}. Check that inbox (and spam).` }] });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[owner.user.email, "[Test] Email delivery works"]]);

    expect((await read(await put("storage", storageBody()))).status).toBe(200);
    const storage = await read<ProbeResult>(await probe("storage"));
    expect(storage.body).toMatchObject({ kind: "storage", source: "admin", ok: true });
    expect(storage.body.steps.map((s) => [s.id, s.status])).toEqual([
      ["upload", "ok"],
      ["read", "ok"],
      ["delete", "ok"],
      ["cors", "info"],
    ]);

    const rows = (await auditSince(since)).filter((r) => r.action === "Tested integration");
    expect(rows.map((r) => [r.target, r.detail])).toEqual([
      ["Integrations · Payment provider", "Test Razorpay keys: accepted. Used the server file."],
      ["Integrations · Email delivery", "Send test email: sent. Used the server file."],
      ["Integrations · Installer storage", "Test bucket: upload ok, read ok, delete ok."],
    ]);
    const audit = JSON.stringify(rows);
    for (const value of [owner.user.email, "smtp.env.example", "axs-route-test", "acc123", ENV.PAYMENT_KEY_ID]) expect(audit.includes(value), value).toBe(false);
    expect(logs.filter((l) => l.includes('"event":"integration_tested"'))).toHaveLength(3);
  });

  it("reports rejected keys as a result, 409 when nothing is configured, and limits tests to 10 per 10 minutes", async () => {
    setIntegrationProbeClientsForTests({ fetch: async () => json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }) });
    const rejected = await read<ProbeResult>(await probe("payments"));
    expect([rejected.status, rejected.body.ok, rejected.body.steps[0]?.message]).toEqual([200, false, "Razorpay rejected the Key ID or Key secret."]);
    const detail = (await db.auditLog.findFirst({ where: { actorId: owner.user.id, action: "Tested integration" }, orderBy: { createdAt: "desc" } }))?.detail;
    expect(detail).toBe("Test Razorpay keys: rejected. Used the server file.");

    setIntegrationEnvForTests({ NODE_ENV: "production" });
    const none = await read(await probe("email"));
    expect([none.status, none.code]).toEqual([409, "integration_not_configured"]);
    const badBody = await read(await probe("email", owner, { to: "someone@example.com" }));
    expect(badBody.status).toBe(422);

    setIntegrationEnvForTests(ENV);
    for (let i = 2; i < 10; i += 1) expect((await read(await probe("payments"))).status).toBe(200);
    const limited = await read(await probe("payments"));
    expect([limited.status, limited.code]).toEqual([429, "too_many_attempts"]);
  });
});
