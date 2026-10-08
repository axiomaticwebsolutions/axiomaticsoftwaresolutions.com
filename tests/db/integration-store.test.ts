/**
 * Saved integrations against the database (lib/integrations/store.ts + resolver.ts): encryption at rest, revisions,
 * required secrets, keep-on-empty, clear and remove, precedence over the env file, and immediate invalidation in the
 * saving process. Every test deletes the IntegrationConfig rows it created (by kind) and invalidates the cache.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { User } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { openIntegrationSecret } from "@/lib/integrations/crypto";
import { toDbKind, type IntegrationKind } from "@/lib/integrations/model";
import { getIntegrationSnapshot, invalidateIntegrations, resolvePayments, resolveStorage, setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import { clearIntegrationSecret, deleteIntegration, loadIntegrationRows, writeIntegration } from "@/lib/integrations/store";
import { makeStaff } from "../support/admin-fixtures";

const KEY_SECRET = "rzp-key-secret-0001";
const WEBHOOK_SECRET = "whsec-integration-store-0001";
const STORAGE_SECRET = "storage-secret-access-key-01";
const PAYMENTS = { provider: "razorpay" as const, keyId: "rzp_test_StoreTest0001" };
const STORAGE = { preset: "r2" as const, endpoint: "https://acc123.r2.cloudflarestorage.com", region: "auto", bucket: "axs-store-test", accessKeyId: "a1b2c3d4e5", forcePathStyle: true };

let owner: User;
const ikm = () => getLicenseKeySecrets().encKey;
const used = new Set<IntegrationKind>();

beforeAll(async () => {
  owner = await makeStaff("OWNER");
});
afterEach(async () => {
  await db.integrationConfig.deleteMany({ where: { kind: { in: [...used].map(toDbKind) } } });
  used.clear();
  setIntegrationEnvForTests(null);
  invalidateIntegrations();
});

async function savePayments(secrets: Partial<Record<"keySecret" | "webhookSecret", string>>, expectedRevision: number | null, keyId = PAYMENTS.keyId) {
  used.add("payments");
  return db.$transaction((tx) => writeIntegration(tx, { kind: "payments", settings: { ...PAYMENTS, keyId }, secrets, actorId: owner.id, expectedRevision, ikm: ikm() }));
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string; details?: Record<string, unknown> }> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeTruthy();
  return e as { status: number; code: string; details?: Record<string, unknown> };
}

describe("writeIntegration", () => {
  it("stores settings in plain JSON and secrets only as AES-GCM ciphertext bound to the kind and field", async () => {
    const result = await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    expect(result).toEqual({ revision: 1, created: true, changed: ["keyId", "keySecret", "webhookSecret"] });
    const config = await db.integrationConfig.findUniqueOrThrow({ where: { kind: "PAYMENTS" }, include: { secrets: true } });
    expect(config).toMatchObject({ revision: 1, settings: PAYMENTS, updatedById: owner.id });
    expect(JSON.stringify(config)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(config)).not.toContain(WEBHOOK_SECRET);
    const byField = Object.fromEntries(config.secrets.map((s) => [s.field, s]));
    expect(byField.keySecret?.last4).toBe("0001");
    expect(byField.webhookSecret?.last4).toBe("0001");
    expect(openIntegrationSecret("payments", "webhookSecret", byField.webhookSecret?.ciphertext ?? "", ikm())).toBe(WEBHOOK_SECRET);
    expect(() => openIntegrationSecret("storage", "webhookSecret", byField.webhookSecret?.ciphertext ?? "", ikm())).toThrow();
    const rows = await loadIntegrationRows();
    expect(rows.find((r) => r.kind === "payments")).toMatchObject({ revision: 1, updatedBy: { id: owner.id, name: owner.name } });
  });

  it("keeps a stored secret when none is entered, replaces it when one is, and writes nothing for an unchanged save", async () => {
    await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    const before = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    expect(await savePayments({}, 1, "rzp_test_StoreTest0002")).toEqual({ revision: 2, created: false, changed: ["keyId"] });
    const kept = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    expect(kept.ciphertext).toBe(before.ciphertext);
    expect(await savePayments({ keySecret: "rzp-key-secret-0002" }, 2, "rzp_test_StoreTest0002")).toEqual({ revision: 3, created: false, changed: ["keySecret"] });
    const replaced = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    expect(openIntegrationSecret("payments", "keySecret", replaced.ciphertext, ikm())).toBe("rzp-key-secret-0002");
    expect(await savePayments({}, 3, "rzp_test_StoreTest0002")).toEqual({ revision: 3, created: false, changed: [] });
  });

  it("refuses a stale revision (409 integration_changed) and a first save without a required secret (422 naming it)", async () => {
    const missing = await failure(savePayments({ keySecret: KEY_SECRET }, null));
    expect([missing.status, missing.code]).toEqual([422, "validation_failed"]);
    expect(missing.details?.fieldErrors).toEqual({ webhookSecret: ["Enter the webhook secret."] });
    expect(await db.integrationConfig.count({ where: { kind: "PAYMENTS" } })).toBe(0);
    await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    for (const stale of [null, 2]) {
      const e = await failure(savePayments({}, stale, "rzp_test_StoreTest0003"));
      expect([e.status, e.code]).toEqual([409, "integration_changed"]);
    }
  });

  it("asks for every stored secret again when the saved settings are unreadable (where they went is unknown)", async () => {
    await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    await db.integrationConfig.update({ where: { kind: "PAYMENTS" }, data: { settings: { provider: "razorpay", keyId: 42 } } });
    const e = await failure(savePayments({}, 1));
    expect([e.status, e.details?.fieldErrors]).toEqual([422, { keySecret: ["Enter it again."], webhookSecret: ["Enter it again."] }]);
    expect(await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, 1)).toMatchObject({ revision: 2, changed: ["keyId", "keySecret", "webhookSecret"] });
  });

  it("serialises two first saves: one wins, the other gets 409", async () => {
    const results = await Promise.allSettled([
      savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null),
      savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null, "rzp_test_StoreTest0009"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("integration_changed");
    expect(await db.integrationConfig.count({ where: { kind: "PAYMENTS" } })).toBe(1);
  });
});

describe("precedence through the resolver (database rows)", () => {
  const ENV = {
    NODE_ENV: "test",
    STORAGE_DRIVER: "s3",
    STORAGE_BUCKET: "env-bucket",
    STORAGE_REGION: "ap-south-1",
    STORAGE_ACCESS_KEY_ID: "AKIAENVSTORE",
    STORAGE_SECRET_ACCESS_KEY: "env-storage-secret-01",
  };

  async function saveStorage(secrets: Partial<Record<"secretAccessKey", string>>, expectedRevision: number | null) {
    used.add("storage");
    return db.$transaction((tx) => writeIntegration(tx, { kind: "storage", settings: STORAGE, secrets, actorId: owner.id, expectedRevision, ikm: ikm() }));
  }

  it("uses a save in the saving process at once, wins over the env file, and falls back to it after removal", async () => {
    setIntegrationEnvForTests(ENV);
    expect(await resolveStorage()).toMatchObject({ source: "env", config: { bucket: "env-bucket" } });
    await saveStorage({ secretAccessKey: STORAGE_SECRET }, null);
    expect(await resolveStorage()).toMatchObject({ source: "env" }); // cached until the saving request invalidates
    invalidateIntegrations();
    expect(await resolveStorage()).toMatchObject({
      source: "admin",
      config: { driver: "s3", bucket: "axs-store-test", endpoint: STORAGE.endpoint, secretAccessKey: STORAGE_SECRET, accessKeyId: STORAGE.accessKeyId },
    });
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect(snap.admin.storage).toMatchObject({ revision: 1, updatedByName: owner.name, settings: STORAGE });
    expect(snap.admin.storage?.secrets.secretAccessKey).toMatchObject({ last4: "y-01", updatedByName: owner.name });
    expect(JSON.stringify(snap.admin)).not.toContain(STORAGE_SECRET);

    expect(await db.$transaction((tx) => deleteIntegration(tx, "storage"))).toBe(true);
    expect(await db.integrationSecret.count({ where: { kind: "STORAGE" } })).toBe(0);
    invalidateIntegrations();
    expect(await resolveStorage()).toMatchObject({ source: "env", config: { bucket: "env-bucket" } });
    expect(await db.$transaction((tx) => deleteIntegration(tx, "storage"))).toBe(false);
  });

  it("clearing a required secret makes the integration 'not configured' (admin_incomplete), never the env file", async () => {
    setIntegrationEnvForTests({ ...ENV, PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_EnvKeyStore01", PAYMENT_KEY_SECRET: "env-key-secret", PAYMENT_WEBHOOK_SECRET: "env-webhook-secret-01" });
    await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    invalidateIntegrations();
    expect(await resolvePayments()).toMatchObject({ source: "admin", config: { keyId: PAYMENTS.keyId, mode: "test" } });
    const cleared = await db.$transaction((tx) => clearIntegrationSecret(tx, { kind: "payments", field: "webhookSecret", actorId: owner.id }));
    expect(cleared).toEqual({ revision: 2, cleared: true });
    expect(await db.$transaction((tx) => clearIntegrationSecret(tx, { kind: "payments", field: "webhookSecret", actorId: owner.id }))).toEqual({ revision: 2, cleared: false });
    expect(await db.$transaction((tx) => clearIntegrationSecret(tx, { kind: "email", field: "password", actorId: owner.id }))).toBeNull();
    invalidateIntegrations();
    expect(await resolvePayments()).toEqual({ source: "none", reason: "admin_incomplete", names: ["webhookSecret"] });
  });

  it("fails closed when a saved secret cannot be decrypted (a ciphertext copied from another kind)", async () => {
    await savePayments({ keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }, null);
    await saveStorage({ secretAccessKey: STORAGE_SECRET }, null);
    const foreign = await db.integrationSecret.findUniqueOrThrow({ where: { kind_field: { kind: "PAYMENTS", field: "keySecret" } } });
    await db.integrationSecret.update({ where: { kind_field: { kind: "STORAGE", field: "secretAccessKey" } }, data: { ciphertext: foreign.ciphertext } });
    setIntegrationEnvForTests(ENV);
    expect(await resolveStorage({ fresh: true })).toEqual({ source: "none", reason: "admin_unreadable", names: ["secretAccessKey"] });
    expect((await resolvePayments({ fresh: true })).source).toBe("admin");
  });
});
