/**
 * The Admin test buttons (docs/admin-integrations-design.md section 16): "Test Razorpay keys", "Send test email" and
 * "Test bucket". Each probe builds a ONE-OFF client from the effective configuration it is given (never the pooled or
 * cached one) and disposes of it. Every step has a 10 s timeout. Messages are fixed sentences: they never echo a key,
 * secret, host, bucket or the provider's own error text (errors are mapped by name and code).
 * Clients are injectable for tests: `fetch` (Razorpay), `transportFactory` (email), `driverFactory` (storage).
 * Authorization, rate limits and audit are the caller's job (lib/admin/settings/integration-actions.ts).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { formatDateTimeIST } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/lib/db";
import { createEmailTransport, type EmailTransport } from "@/lib/email/transport";
import { createPaymentProvider } from "@/lib/payments";
import { RazorpayProvider } from "@/lib/payments/razorpay";
import { createStorageDriver, type StorageDriver } from "@/lib/storage";
import { S3StorageDriver } from "@/lib/storage/s3";
import type { EmailConfig, PaymentsConfig, ProbeResult, ProbeStep, Resolved, StorageConfig } from "./types";

export const PROBE_STEP_TIMEOUT_MS = 10_000;
export const STORAGE_PROBE_PREFIX = "axs-probe/";
export const TEST_EMAIL_SUBJECT = "[Test] Email delivery works";

type Configured<C> = Extract<Resolved<C>, { source: "admin" | "env" }>;

class ProbeTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor() {
    super("The step took too long");
    this.name = "ProbeTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms = PROBE_STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function result(kind: ProbeResult["kind"], source: "admin" | "env", steps: ProbeStep[], now: Date): ProbeResult {
  const ok = steps.every((s) => s.status !== "failed") && steps.some((s) => s.status === "ok" || s.status === "info");
  return { kind, source, ok, testedAt: now.toISOString(), steps };
}

function errorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string") return e.code;
  return typeof e?.name === "string" ? e.name : "";
}

// ---------- Payments ----------

export type PaymentsProbeOptions = {
  fetch?: typeof fetch;
  client?: Db;
  /** When the saved webhook secret was last changed (Admin); null for the env file. */
  webhookSecretUpdatedAt?: Date | null;
  now?: Date;
};

/** "Test Razorpay keys": one authenticated read-only call, then when the last signed webhook arrived (info). */
export async function probePayments(resolved: Configured<PaymentsConfig>, opts: PaymentsProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? new Date();
  const config = resolved.config;
  if (config.provider === "mock") {
    return result("payments", resolved.source, [{ id: "mock", label: "Mock provider", status: "info", message: "Mock provider: nothing to test." }], now);
  }
  const steps: ProbeStep[] = [];
  const provider = createPaymentProvider(config, { fetch: opts.fetch, timeoutMs: PROBE_STEP_TIMEOUT_MS });
  try {
    if (!(provider instanceof RazorpayProvider)) throw new Error("Not a Razorpay adapter");
    const verdict = await withTimeout(provider.checkCredentials());
    steps.push(
      verdict === "ok"
        ? { id: "keys", label: "Keys", status: "ok", message: `Razorpay accepted the keys (${config.mode} mode).` }
        : { id: "keys", label: "Keys", status: "failed", message: "Razorpay rejected the Key ID or Key secret." },
    );
  } catch {
    steps.push({ id: "keys", label: "Keys", status: "failed", message: "Couldn’t reach Razorpay. Try again in a minute." });
  }
  steps.push(await webhookStep(opts.client ?? defaultDb, opts.webhookSecretUpdatedAt ?? null));
  return result("payments", resolved.source, steps, now);
}

async function webhookStep(client: Db, secretUpdatedAt: Date | null): Promise<ProbeStep> {
  const label = "Webhook secret";
  try {
    const last = await client.webhookDelivery.findFirst({
      where: { provider: "razorpay", signatureOk: true },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    });
    if (last && (secretUpdatedAt === null || last.receivedAt.getTime() > secretUpdatedAt.getTime())) {
      return { id: "webhook", label, status: "info", message: `Last signed webhook: ${formatDateTimeIST(last.receivedAt)}.` };
    }
    const since = secretUpdatedAt === null ? "yet" : "since this secret was saved";
    return { id: "webhook", label, status: "info", message: `No signed webhook ${since}. Razorpay sends one with the next payment.` };
  } catch {
    return { id: "webhook", label, status: "skipped", message: "Couldn’t look up recent webhooks." };
  }
}

// ---------- Email ----------

export type EmailProbeOptions = {
  /** The signed-in Owner's own address: the only recipient a test ever goes to. */
  to: string;
  /** Builds the one-off transport (default createEmailTransport(config, { pool: false })). */
  transportFactory?: (config: EmailConfig) => Promise<EmailTransport>;
  now?: Date;
};

/** The probe's message for a send error, by code (never the server's reply). */
export function emailFailureMessage(error: unknown): string {
  const code = errorCode(error);
  const status = (error as { responseCode?: unknown } | null)?.responseCode;
  const smtpStatus = typeof status === "number" ? status : 0;
  if (code === "EBLOCKEDADDRESS") return "Blocked: the host points to a private network address.";
  if (code === "EAUTH" || smtpStatus === 535) return "The server rejected the username or password.";
  if (code === "ETLS") return "The secure connection failed. Check the port and security setting.";
  if (["ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return "Couldn’t connect to the SMTP host.";
  }
  if (code === "EENVELOPE" || (smtpStatus >= 500 && smtpStatus < 600)) return "The server refused the message. Check the From address.";
  return "Couldn’t send the test email.";
}

const AWS_KEY_ERRORS = [
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "IncompleteSignature",
  "MissingAuthenticationTokenException",
];
const AWS_THROTTLE_ERRORS = ["TooManyRequestsException", "ThrottlingException", "Throttling", "LimitExceededException"];
const NETWORK_ERRORS = [
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "TimeoutError",
  "RequestTimeout",
  "NetworkingError",
  "ProbeTimeoutError",
];

/**
 * The probe's message for an Amazon SES (AWS SDK) error, by exception name, code and HTTP status: never the AWS error
 * text (it can name the identity or the account) and never a key. nodemailer tags SDK errors with code ESES, so the
 * name decides first.
 */
export function sesFailureMessage(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const code = typeof e?.code === "string" ? e.code : typeof e?.Code === "string" ? e.Code : "";
  const status = typeof e?.$metadata?.httpStatusCode === "number" ? e.$metadata.httpStatusCode : 0;
  const is = (list: readonly string[]) => list.includes(name) || list.includes(code);
  if (is(AWS_KEY_ERRORS)) return "AWS rejected the access key ID or secret access key.";
  if (is(["MessageRejected", "MailFromDomainNotVerifiedException"])) {
    return "Amazon SES refused the message: verify the From address or its domain in SES (in the SES sandbox, verify the recipient too).";
  }
  if (is(["AccessDenied", "AccessDeniedException"])) return "This access key isn’t allowed to send email. Allow ses:SendEmail and ses:SendRawEmail.";
  if (is(AWS_THROTTLE_ERRORS)) return "Amazon SES is throttling sends (rate or daily quota). Try again later.";
  if (is(["SendingPausedException", "AccountSuspendedException"])) return "Sending is paused for this AWS account or configuration set. Check the SES console.";
  if (is(["NotFoundException"])) return "Amazon SES couldn’t find the configuration set in this region.";
  if (is(NETWORK_ERRORS)) return "Couldn’t reach Amazon SES. Try again in a minute.";
  if (status === 403) return "AWS rejected the access key ID or secret access key.";
  return "Couldn’t send the test email.";
}

/** "Send test email": one message to the Owner's own address through a one-off transport. */
export async function probeEmail(resolved: Configured<EmailConfig>, opts: EmailProbeOptions): Promise<ProbeResult> {
  const now = opts.now ?? new Date();
  const label = "Send test email";
  const text = `This test was sent from Admin > Settings > Integrations on ${formatDateTimeIST(now)}.`;
  let transport: EmailTransport | null = null;
  let step: ProbeStep;
  try {
    transport = await (opts.transportFactory ?? ((config) => createEmailTransport(config, { pool: false })))(resolved.config);
    await withTimeout(
      transport.send({ to: opts.to, subject: TEST_EMAIL_SUBJECT, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/>/g, "&gt;").replace(/</g, "&lt;")}</p>`, templateId: "integration_test" }),
    );
    step =
      resolved.config.transport === "console"
        ? { id: "send", label, status: "ok", message: "Sent to the dev mailbox (/dev/mailbox)." }
        : { id: "send", label, status: "ok", message: `Sent to ${opts.to}. Check that inbox (and spam).` };
  } catch (error) {
    const message = resolved.config.transport === "ses" ? sesFailureMessage(error) : emailFailureMessage(error);
    step = { id: "send", label, status: "failed", message };
  } finally {
    try {
      transport?.close?.();
    } catch {
      // Closing a one-off transport never fails the probe.
    }
  }
  return result("email", resolved.source, [step], now);
}

// ---------- Storage ----------

export type StorageProbeOptions = {
  /** Builds the one-off driver (default createStorageDriver(config)). */
  driverFactory?: (config: StorageConfig) => StorageDriver;
  now?: Date;
};

/** The probe's message for a storage error, by name and code (never the store's own text). */
export function storageFailureMessage(error: unknown): string {
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const code = errorCode(error);
  const status = e?.$metadata?.httpStatusCode;
  if (code === "EBLOCKEDADDRESS" || name === "BlockedAddressError") return "Blocked: private network address.";
  if (name === "NoSuchBucket" || e?.Code === "NoSuchBucket") return "Bucket not found.";
  if (["AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId", "Forbidden", "InvalidToken"].includes(name) || status === 403) {
    return "Access denied. Check the access key and its bucket permissions.";
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "TimeoutError", "ProbeTimeoutError", "EHOSTUNREACH"].includes(code)) {
    return "Couldn’t reach the endpoint.";
  }
  return "The storage request failed.";
}

/** "Test bucket": put, head and delete a tiny object under axs-probe/ (a failed step skips the rest, but never the delete). */
export async function probeStorage(resolved: Configured<StorageConfig>, opts: StorageProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? new Date();
  const steps: ProbeStep[] = [];
  let driver: StorageDriver | null = null;
  try {
    driver = (opts.driverFactory ?? createStorageDriver)(resolved.config);
  } catch (error) {
    steps.push({ id: "upload", label: "Upload a test file", status: "failed", message: storageFailureMessage(error) });
    return result("storage", resolved.source, steps, now);
  }
  const key = `${STORAGE_PROBE_PREFIX}${randomUUID()}.txt`;
  const body = Buffer.from(`axs storage probe ${now.toISOString()}`, "utf8");
  let uploaded = false;
  try {
    await withTimeout(driver.putObject(key, body, "text/plain"));
    uploaded = true;
    steps.push({ id: "upload", label: "Upload a test file", status: "ok", message: "OK" });
  } catch (error) {
    steps.push({ id: "upload", label: "Upload a test file", status: "failed", message: storageFailureMessage(error) });
  }
  if (uploaded) {
    try {
      const head = await withTimeout(driver.head(key));
      if (!head) steps.push({ id: "read", label: "Read it back", status: "failed", message: "The test file wasn’t found after the upload." });
      else if (head.sizeBytes !== body.length) steps.push({ id: "read", label: "Read it back", status: "failed", message: "The test file came back with a different size." });
      else steps.push({ id: "read", label: "Read it back", status: "ok", message: "OK" });
    } catch (error) {
      steps.push({ id: "read", label: "Read it back", status: "failed", message: storageFailureMessage(error) });
    }
    try {
      await withTimeout(driver.delete(key));
      steps.push({ id: "delete", label: "Delete it", status: "ok", message: "OK" });
    } catch (error) {
      steps.push({ id: "delete", label: "Delete it", status: "failed", message: storageFailureMessage(error) });
    }
  } else {
    steps.push({ id: "read", label: "Read it back", status: "skipped", message: "Skipped." });
    steps.push({ id: "delete", label: "Delete it", status: "skipped", message: "Skipped." });
  }
  if (resolved.config.driver === "s3") {
    steps.push({ id: "cors", label: "Browser uploads", status: "info", message: "Browser uploads also need the bucket’s CORS rule; this test can’t check it." });
  }
  if (driver instanceof S3StorageDriver) driver.destroy();
  return result("storage", resolved.source, steps, now);
}
