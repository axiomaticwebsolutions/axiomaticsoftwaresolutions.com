/**
 * The Admin test buttons (lib/integrations/probes.ts; docs/admin-integrations-design.md section 16), with injected
 * clients: Razorpay through `fetch`, email through a transport factory, storage through a driver factory.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import type { EmailTransport, OutgoingEmail } from "@/lib/email/transport";
import { createSesTransport } from "@/lib/email/transports/ses";
import {
  emailFailureMessage,
  probeEmail,
  probePayments,
  probeStorage,
  sesFailureMessage,
  storageFailureMessage,
  STORAGE_PROBE_PREFIX,
  TEST_EMAIL_SUBJECT,
} from "@/lib/integrations/probes";
import type { EmailConfig, PaymentsConfig, StorageConfig } from "@/lib/integrations/types";
import { LocalStorageDriver } from "@/lib/storage/local";
import type { StorageDriver } from "@/lib/storage";

const NOW = new Date("2026-10-08T08:30:00Z");
const KEY_ID = "rzp_test_1DP5mmOlF5G5ag";
const KEY_SECRET = "probe-key-secret-0001";
const razorpay: PaymentsConfig = { provider: "razorpay", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: "probe-webhook-secret-0001", mode: "test" };
const configured = <C>(config: C, source: "admin" | "env" = "admin") => ({ source, config, fingerprint: "f" }) as const;

const deliveries = (receivedAt: Date | null) =>
  ({ webhookDelivery: { findFirst: vi.fn(async () => (receivedAt ? { receivedAt } : null)) } }) as unknown as Db;
const fetchAnswering = (status: number) =>
  vi.fn(async () => new Response(JSON.stringify(status === 200 ? { entity: "collection", items: [] } : { error: { code: "BAD_REQUEST_ERROR" } }), { status })) as unknown as typeof fetch;

describe("probePayments", () => {
  it("reports accepted keys and the last signed webhook since the secret was saved", async () => {
    const fetch = fetchAnswering(200);
    const result = await probePayments(configured(razorpay), {
      fetch,
      client: deliveries(new Date("2026-10-08T08:32:00Z")),
      webhookSecretUpdatedAt: new Date("2026-10-08T08:00:00Z"),
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "payments", source: "admin", ok: true, testedAt: NOW.toISOString() });
    expect(result.steps).toEqual([
      { id: "keys", label: "Keys", status: "ok", message: "Razorpay accepted the keys (test mode)." },
      { id: "webhook", label: "Webhook secret", status: "info", message: "Last signed webhook: 8 Oct 2026, 14:02." },
    ]);
    expect(String((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])).toBe("https://api.razorpay.com/v1/orders?count=1");
  });

  it("reports rejected keys, an unreachable Razorpay, and no webhook since the secret changed, never echoing a key", async () => {
    const rejected = await probePayments(configured(razorpay, "env"), { fetch: fetchAnswering(401), client: deliveries(null), now: NOW });
    expect(rejected.ok).toBe(false);
    expect(rejected.source).toBe("env");
    expect(rejected.steps.map((s) => s.message)).toEqual([
      "Razorpay rejected the Key ID or Key secret.",
      "No signed webhook yet. Razorpay sends one with the next payment.",
    ]);
    const down = await probePayments(configured(razorpay), {
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      client: deliveries(new Date("2026-10-01T00:00:00Z")),
      webhookSecretUpdatedAt: new Date("2026-10-08T08:00:00Z"),
      now: NOW,
    });
    expect(down.steps.map((s) => [s.status, s.message])).toEqual([
      ["failed", "Couldn’t reach Razorpay. Try again in a minute."],
      ["info", "No signed webhook since this secret was saved. Razorpay sends one with the next payment."],
    ]);
    const text = JSON.stringify([rejected, down]);
    expect(text).not.toContain(KEY_ID);
    expect(text).not.toContain(KEY_SECRET);
  });

  it("has nothing to test for the mock", async () => {
    const result = await probePayments(configured({ provider: "mock", keyId: "mock_key", keySecret: "k", webhookSecret: "w", mode: "test" } as PaymentsConfig, "env"), { now: NOW });
    expect(result).toMatchObject({ ok: true, steps: [{ status: "info", message: "Mock provider: nothing to test." }] });
  });
});

describe("probeEmail", () => {
  const smtp: EmailConfig = {
    transport: "smtp",
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    auth: { user: "mailer", pass: "smtp-password-0001" },
    from: { name: "Axiomatic", address: "no-reply@axiomatic.example" },
  };
  const OWNER = "owner@axiomatic.example";

  function factory(send: (m: OutgoingEmail) => Promise<{ messageId: string }>) {
    const sent: OutgoingEmail[] = [];
    const close = vi.fn();
    const make = vi.fn(async (): Promise<EmailTransport> => ({ name: "smtp", send: async (m) => (sent.push(m), send(m)), close }));
    return { make, sent, close };
  }

  it("sends one test message to the Owner's own address through a one-off transport, then closes it", async () => {
    const f = factory(async () => ({ messageId: "m1" }));
    const result = await probeEmail(configured(smtp), { to: OWNER, transportFactory: f.make, now: NOW });
    expect(result).toMatchObject({ kind: "email", ok: true, steps: [{ status: "ok", message: `Sent to ${OWNER}. Check that inbox (and spam).` }] });
    expect(f.make).toHaveBeenCalledWith(smtp);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ to: OWNER, subject: TEST_EMAIL_SUBJECT, templateId: "integration_test" });
    expect(f.sent[0]?.text).toBe("This test was sent from Admin > Settings > Integrations on 8 Oct 2026, 14:00.");
    expect(f.sent[0]?.html).toContain("Admin &gt; Settings &gt; Integrations");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("maps send errors by code to fixed messages, never the server's reply", async () => {
    const f = factory(async () => {
      throw Object.assign(new Error("535 5.7.8 Username and Password not accepted for mailer"), { code: "EAUTH", responseCode: 535 });
    });
    const result = await probeEmail(configured(smtp), { to: OWNER, transportFactory: f.make, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.message).toBe("The server rejected the username or password.");
    expect(JSON.stringify(result)).not.toMatch(/mailer|535 5\.7\.8|smtp-password/);
    expect(f.close).toHaveBeenCalled();
    expect(emailFailureMessage(Object.assign(new Error("x"), { code: "EBLOCKEDADDRESS" }))).toBe("Blocked: the host points to a private network address.");
    expect(emailFailureMessage(Object.assign(new Error("x"), { code: "ETLS" }))).toBe("The secure connection failed. Check the port and security setting.");
    expect(emailFailureMessage(Object.assign(new Error("x"), { code: "ECONNECTION" }))).toBe("Couldn’t connect to the SMTP host.");
    expect(emailFailureMessage(Object.assign(new Error("x"), { code: "EENVELOPE", responseCode: 553 }))).toBe("The server refused the message. Check the From address.");
    expect(emailFailureMessage(new Error("weird"))).toBe("Couldn’t send the test email.");
  });

  it("Amazon SES: sends through a one-off SES transport and maps AWS errors to fixed messages, never keys or AWS text", async () => {
    const ses: EmailConfig = {
      transport: "ses",
      region: "ap-south-1",
      accessKeyId: "AKIAPROBEKEY00000001",
      secretAccessKey: "probe-ses-secret-key-0001",
      configurationSet: null,
      from: smtp.from,
    };
    const awsError = (name: string, status: number, message = `${name}: AKIAPROBEKEY00000001 for ${OWNER} in account 123456789012`) =>
      Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
    const destroy = vi.fn();
    const sendWith = (outcome: () => Promise<unknown>) => async (config: EmailConfig) =>
      createSesTransport(config as Extract<EmailConfig, { transport: "ses" }>, { send: outcome, destroy });
    const ok = await probeEmail(configured(ses), { to: OWNER, transportFactory: sendWith(async () => ({ MessageId: "m-1" })), now: NOW });
    expect(ok).toMatchObject({ ok: true, steps: [{ status: "ok", message: `Sent to ${OWNER}. Check that inbox (and spam).` }] });
    expect(destroy).toHaveBeenCalledTimes(1);

    const cases: [unknown, string][] = [
      [awsError("InvalidClientTokenId", 403), "AWS rejected the access key ID or secret access key."],
      [awsError("SignatureDoesNotMatch", 403), "AWS rejected the access key ID or secret access key."],
      [awsError("UnrecognizedClientException", 403), "AWS rejected the access key ID or secret access key."],
      [awsError("MessageRejected", 400), "Amazon SES refused the message: verify the From address or its domain in SES (in the SES sandbox, verify the recipient too)."],
      [awsError("MailFromDomainNotVerifiedException", 400), "Amazon SES refused the message: verify the From address or its domain in SES (in the SES sandbox, verify the recipient too)."],
      [awsError("AccessDeniedException", 403), "This access key isn’t allowed to send email. Allow ses:SendEmail and ses:SendRawEmail."],
      [awsError("TooManyRequestsException", 429), "Amazon SES is throttling sends (rate or daily quota). Try again later."],
      [awsError("LimitExceededException", 400), "Amazon SES is throttling sends (rate or daily quota). Try again later."],
      [awsError("SendingPausedException", 400), "Sending is paused for this AWS account or configuration set. Check the SES console."],
      [awsError("NotFoundException", 404), "Amazon SES couldn’t find the configuration set in this region."],
      [Object.assign(new Error("getaddrinfo ENOTFOUND email.ap-south-1.amazonaws.com"), { code: "ENOTFOUND" }), "Couldn’t reach Amazon SES. Try again in a minute."],
      [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "Couldn’t reach Amazon SES. Try again in a minute."],
      [awsError("SomethingNew", 403), "AWS rejected the access key ID or secret access key."],
      [new Error("weird"), "Couldn’t send the test email."],
    ];
    for (const [error, message] of cases) {
      const result = await probeEmail(configured(ses, "env"), { to: OWNER, transportFactory: sendWith(async () => Promise.reject(error)), now: NOW });
      expect([result.ok, result.steps[0]?.message], (error as Error).name).toEqual([false, message]);
      expect(JSON.stringify(result)).not.toMatch(/AKIAPROBEKEY|probe-ses-secret|123456789012/);
      expect(sesFailureMessage(error)).toBe(message);
    }
  });

  it("points to the dev mailbox for the console transport", async () => {
    const f = factory(async () => ({ messageId: "c1" }));
    const result = await probeEmail(configured({ transport: "console", from: smtp.from } as EmailConfig, "env"), { to: OWNER, transportFactory: f.make, now: NOW });
    expect(result.steps[0]?.message).toBe("Sent to the dev mailbox (/dev/mailbox).");
  });
});

describe("probeStorage", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "axs-probe-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const local: StorageConfig = { driver: "local", dir: "" };
  const localFactory = () => new LocalStorageDriver({ dir, appUrl: "http://localhost:3000", secret: "probe-test-secret-0123456789" });

  it("uploads, reads back and deletes a probe object under axs-probe/", async () => {
    const result = await probeStorage(configured(local, "env"), { driverFactory: localFactory, now: NOW });
    expect(result).toMatchObject({ kind: "storage", source: "env", ok: true });
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ["upload", "ok"],
      ["read", "ok"],
      ["delete", "ok"],
    ]);
    expect(await readdir(path.join(dir, STORAGE_PROBE_PREFIX.replace("/", "")))).toEqual([]);
  });

  it("skips read and delete when the upload fails, still deletes when the read fails, and adds the CORS note for S3", async () => {
    const denied = Object.assign(new Error("Access Denied for bucket axs-files"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    const failing = (over: Partial<StorageDriver>) => () => ({ ...localFactory(), kind: "s3", ...over }) as unknown as StorageDriver;
    const s3: StorageConfig = { driver: "s3", endpoint: null, region: "ap-south-1", bucket: "axs-files", forcePathStyle: false, accessKeyId: "AKIAPROBE", secretAccessKey: "probe-storage-secret" };
    const put = await probeStorage(configured(s3), { driverFactory: failing({ putObject: async () => Promise.reject(denied) }), now: NOW });
    expect(put.ok).toBe(false);
    expect(put.steps.map((s) => [s.id, s.status, s.message])).toEqual([
      ["upload", "failed", "Access denied. Check the access key and its bucket permissions."],
      ["read", "skipped", "Skipped."],
      ["delete", "skipped", "Skipped."],
      ["cors", "info", "Browser uploads also need the bucket’s CORS rule; this test can’t check it."],
    ]);
    const deleted: string[] = [];
    const head = await probeStorage(configured(s3), {
      driverFactory: failing({
        putObject: async () => undefined,
        head: async () => Promise.reject(Object.assign(new Error("x"), { name: "NoSuchBucket" })),
        delete: async (key: string) => void deleted.push(key),
      }),
      now: NOW,
    });
    expect(head.steps.slice(0, 3).map((s) => [s.id, s.status, s.message])).toEqual([
      ["upload", "ok", "OK"],
      ["read", "failed", "Bucket not found."],
      ["delete", "ok", "OK"],
    ]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^axs-probe\/[0-9a-f-]{36}\.txt$/);
    expect(JSON.stringify([put, head])).not.toMatch(/axs-files|AKIAPROBE|probe-storage-secret/);
    expect(storageFailureMessage(Object.assign(new Error("x"), { code: "EBLOCKEDADDRESS" }))).toBe("Blocked: private network address.");
    expect(storageFailureMessage(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("Couldn’t reach the endpoint.");
  });
});
