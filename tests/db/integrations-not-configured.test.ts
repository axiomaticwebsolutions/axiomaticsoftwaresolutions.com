/**
 * Not-configured behaviour (docs/admin-integrations-design.md section 9): with no Admin row and nothing usable in the
 * env file (production-like, empty), the app keeps working and each feature answers a clear error:
 * checkout and retry 503 payments_unavailable before any account, password hash or provider call; the Razorpay
 * webhook 503; email fails through the outbox's retry rules; direct sends answer { ok: false }; the template test 409;
 * uploads and downloads 503; maintenance skips the uploads task. Without the override the dev env fallback applies.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/[provider]/route";
import { confirmInstallerUpload, createInstallerUpload } from "@/lib/admin/catalog/releases";
import { EMAIL_NOT_CONFIGURED_MESSAGE, sendTemplateTest } from "@/lib/admin/templates/service";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createCheckoutOrder } from "@/lib/checkout/create-order";
import { PAYMENTS_UNAVAILABLE_MESSAGE, retryPayment } from "@/lib/checkout/payment-attempt";
import { db } from "@/lib/db";
import { issueDownload } from "@/lib/downloads/issue";
import { dispatchPendingEmails, enqueueEmail, OUTBOX_MAX_ATTEMPTS } from "@/lib/email/outbox";
import { sendAuthEmail } from "@/lib/email/send";
import { getEmailTransport, setEmailTransport } from "@/lib/email/transport";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { getIntegrationSnapshot, setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import { runMaintenance } from "@/lib/jobs/maintenance";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { activePaymentProviderOrNull } from "@/lib/payments";
import { attachmentDownloadLink, confirmUpload, createUpload } from "@/lib/portal/uploads";
import { getStorage, setStorage } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";
import { makeCustomer, makeStaff } from "../support/admin-fixtures";
import { makeLicenseRow, makePlan, makeProduct, makeRelease } from "./admin-catalog-fixtures";
import { BILLING, buyerOf, orderRequest, placeOrder, seedCatalog, testIp, uniq, type CatalogFixture } from "./checkout-fixtures";

let cat: CatalogFixture;
let dir = "";

beforeAll(async () => {
  cat = await seedCatalog();
  dir = await mkdtemp(path.join(tmpdir(), "axs-notconf-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  setStorage(null);
  setEmailTransport(null);
  setIntegrationEnvForTests({ NODE_ENV: "production" });
});
afterEach(() => {
  setIntegrationEnvForTests(null);
});

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("nothing saved in Admin and nothing usable in the env file", () => {
  it("resolves every integration to 'not configured'", async () => {
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect([snap.payments, snap.email, snap.storage]).toEqual([
      { source: "none", reason: "missing", names: [] },
      { source: "none", reason: "missing", names: [] },
      { source: "none", reason: "missing", names: [] },
    ]);
    expect(await activePaymentProviderOrNull()).toBeNull();
  });
});

describe("payments", () => {
  it("checkout answers 503 payments_unavailable before the register rate limit, any account or provider call", async () => {
    const ip = testIp();
    const email = `${uniq("nopay")}@example.test`;
    const e = await apiError(
      createCheckoutOrder(
        db,
        orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING, email }, createAccount: { password: "s3cure-pass" } }),
        { buyer: await buyerOf(null), ip },
      ),
    );
    expect([e.status, e.code, e.message]).toEqual([503, "payments_unavailable", PAYMENTS_UNAVAILABLE_MESSAGE]);
    expect(await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.register(ip).key } })).toBeNull();
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await db.order.count({ where: { email } })).toBe(0);
  });

  it("order retry answers 503 payments_unavailable and creates no attempt", async () => {
    setIntegrationEnvForTests(null);
    const placed = await placeOrder(null, { email: `${uniq("noretry")}@example.test`, items: [{ planId: cat.plans.annual.id, qty: 1 }] });
    await db.order.update({ where: { id: placed.orderId }, data: { status: "FAILED" } });
    setIntegrationEnvForTests({ NODE_ENV: "production" });
    const access = await resolveOrderAccessFor(placed.orderId, { auth: null, token: placed.orderToken });
    const e = await apiError(retryPayment(db, access));
    expect([e.status, e.code]).toEqual([503, "payments_unavailable"]);
    expect(await db.payment.count({ where: { orderId: placed.orderId } })).toBe(1);
  });

  it("the Razorpay webhook answers 503 with Retry-After and records nothing", async () => {
    const before = await db.webhookDelivery.count({ where: { provider: "razorpay" } });
    const req = new NextRequest("http://localhost:3000/api/webhooks/payments/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "0".repeat(64) },
      body: JSON.stringify({ entity: "event", event: "payment.captured" }),
    });
    const res = await webhookPOST(req, { params: Promise.resolve({ provider: "razorpay" }) });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payments_not_configured");
    expect(await db.webhookDelivery.count({ where: { provider: "razorpay" } })).toBe(before);
  });
});

describe("email", () => {
  it("outbox rows fail through the retry rules with a clear reason, then become FAILED", async () => {
    const base = new Date("2020-01-01T00:00:00Z"); // far in the past: no other test's row is due at these times
    const dedupeKey = `order_confirmation:${uniq("nomail")}`;
    await db.$transaction((tx) =>
      enqueueEmail(tx, {
        to: "priya@sharmamedicals.example",
        templateId: "order_confirmation",
        vars: { customer_name: "Priya", order_id: "AX-1", order_url: "http://localhost:3000/orders/AX-1", total: "₹1", invoice_number: "X" },
        dedupeKey,
        sendAfter: base,
      }),
    );
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      const now = new Date(base.getTime() + attempt * 2 * 60 * 60_000);
      expect(await dispatchPendingEmails({ now })).toMatchObject({ sent: 0 });
      const row = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey } });
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe("EmailNotConfiguredError email_not_configured: Email delivery is not configured.");
      if (attempt < OUTBOX_MAX_ATTEMPTS) {
        expect(row.status).toBe("PENDING");
        expect(row.sendAfter.getTime()).toBeGreaterThan(now.getTime());
      } else {
        expect(row.status).toBe("FAILED");
      }
    }
    await db.outboxEmail.deleteMany({ where: { dedupeKey } });
  });

  it("direct auth emails answer { ok: false }, and the template test 409 email_not_configured", async () => {
    expect(await sendAuthEmail({ to: "priya@sharmamedicals.example", templateId: "email_verification", vars: { customer_name: "Priya", code: "482913" } })).toEqual({ ok: false });
    await expect(getEmailTransport()).rejects.toMatchObject({ name: "EmailNotConfiguredError", code: "email_not_configured" });
    const owner = await makeStaff("OWNER");
    const e = await apiError(sendTemplateTest("order_confirmation", {}, { staff: { id: owner.id, email: owner.email }, actor: { id: owner.id, role: "owner" } }));
    expect([e.status, e.code, e.message]).toEqual([409, "email_not_configured", EMAIL_NOT_CONFIGURED_MESSAGE]);
  });
});

describe("storage", () => {
  it("ticket attachments: create, confirm and download answer 503 with the existing codes", async () => {
    const customer = await makeCustomer();
    const ref = { accountId: customer.accountId, userId: customer.user.id };
    const create = await apiError(createUpload({ ...ref, file: { fileName: "screen.png", contentType: "image/png", sizeBytes: 100 } }));
    expect([create.status, create.code]).toEqual([503, "upload_unavailable"]);
    expect(await db.upload.count({ where: { uploadedById: customer.user.id } })).toBe(0);
    const upload = await db.upload.create({
      data: { accountId: customer.accountId, uploadedById: customer.user.id, storageKey: `uploads/${customer.accountId}/${uniq("nc")}/screen.png`, fileName: "screen.png", contentType: "image/png", sizeBytes: 100 },
    });
    const confirm = await apiError(confirmUpload({ ...ref, uploadId: upload.id }));
    expect([confirm.status, confirm.code]).toEqual([503, "upload_unavailable"]);
    const download = await apiError(attachmentDownloadLink({ ...ref, uploadId: upload.id }));
    expect([download.status, download.code]).toEqual([503, "download_unavailable"]);
  });

  it("installer downloads answer 503 download_unavailable and record nothing", async () => {
    const product = await makeProduct({ status: "PUBLISHED", platforms: ["windows"] });
    const plan = await makePlan(product.id);
    const release = await makeRelease(product.id, { status: "PUBLISHED", withFile: true });
    const file = await db.releaseFile.findFirstOrThrow({ where: { releaseId: release.id } });
    const account = await db.businessAccount.create({ data: { legalName: uniq("No Storage Traders") } });
    await makeLicenseRow(product.id, plan.id, account.id);
    const e = await apiError(
      issueDownload(db, { fileId: file.id, scope: { kind: "account", accountId: account.id }, eventUserId: uniq("user"), actorName: "Priya", ttlSec: 600 }),
    );
    expect([e.status, e.code]).toEqual([503, "download_unavailable"]);
    expect(await db.downloadEvent.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("installer uploads: presign and confirm answer 503 upload_unavailable", async () => {
    const owner = await makeStaff("OWNER");
    const ctx = { actor: { id: owner.id, role: "owner" as const }, staffId: owner.id };
    const product = await makeProduct({ platforms: ["windows"] });
    const release = await makeRelease(product.id);
    const input = { platform: "windows" as const, fileName: "Setup-9.0.0.exe", sizeBytes: 64 };
    const presign = await apiError(createInstallerUpload(release.id, input, ctx));
    expect([presign.status, presign.code]).toEqual([503, "upload_unavailable"]);
    // A token issued while storage worked (local driver), confirmed after storage went away.
    const local = new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET });
    const ticket = await createInstallerUpload(release.id, input, ctx, db, local);
    const confirm = await apiError(confirmInstallerUpload(release.id, ticket.uploadToken, ctx));
    expect([confirm.status, confirm.code]).toEqual([503, "upload_unavailable"]);
    expect(await db.releaseFile.count({ where: { releaseId: release.id } })).toBe(0);
  });

  it("maintenance skips the uploads task instead of failing it, and keeps the rows", async () => {
    const customer = await makeCustomer();
    const stale = await db.upload.create({
      data: {
        accountId: customer.accountId,
        uploadedById: customer.user.id,
        storageKey: `uploads/${customer.accountId}/${uniq("stale")}/old.png`,
        fileName: "old.png",
        contentType: "image/png",
        sizeBytes: 10,
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    const result = await runMaintenance({ tasks: ["uploads"] });
    expect(result.uploadsDeleted).toBe(0);
    expect(result.failed).toBeUndefined();
    expect(await db.upload.count({ where: { id: stale.id } })).toBe(1);
    await db.upload.delete({ where: { id: stale.id } });
  });
});

describe("the development env fallback when nothing is saved", () => {
  it("gives the mock provider, the console transport and the local driver", async () => {
    setIntegrationEnvForTests(null);
    const snap = await getIntegrationSnapshot({ fresh: true });
    expect([snap.payments.source, snap.email.source, snap.storage.source]).toEqual(["env", "env", "env"]);
    expect((await activePaymentProviderOrNull())?.key).toBe("mock");
    expect((await getEmailTransport()).name).toBe("console");
    expect(await getStorage()).toBeInstanceOf(LocalStorageDriver);
  });
});
