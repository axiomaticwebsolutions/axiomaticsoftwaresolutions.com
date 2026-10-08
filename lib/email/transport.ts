/**
 * The email transport of the effective email configuration (lib/integrations/resolver.ts: Admin > Settings >
 * Integrations, else the env fallback): "smtp" (nodemailer, pooled), "ses" (Amazon SES API through nodemailer's SES
 * transport and the SESv2 client) or "console" (development only; keeps the message for /dev/mailbox). The
 * process-wide transport is rebuilt when the configuration changes (the old pool or client is closed a minute later,
 * so sends in flight finish). Not configured -> EmailNotConfiguredError. Tests replace it with setEmailTransport().
 */
import "server-only";
import { isProduction } from "@/lib/env";
import { resolveEmail } from "@/lib/integrations/resolver";
import type { EmailConfig } from "@/lib/integrations/types";

/**
 * A file sent with an email. Only rendered by the outbox dispatcher from a typed reference (lib/email/attachments.ts),
 * never from caller-supplied paths, URLs or bytes. PDF only today.
 */
export type OutgoingAttachment = {
  /** Safe file name (letters, digits, "-" and ".pdf"), e.g. "Invoice-AXS-26-27-1181.pdf". */
  filename: string;
  contentType: "application/pdf";
  content: Buffer;
};

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** For logs and the X-Axs-Template header; never the content. */
  templateId: string;
  /** Files sent with the message (multipart/mixed around the HTML + text alternative). */
  attachments?: readonly OutgoingAttachment[];
};

export type EmailSendResult = { messageId: string };

export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail): Promise<EmailSendResult>;
  /** Releases pooled connections (SMTP) or the client's sockets (SES). */
  close?(): void;
}

/** No email configuration is usable. The outbox counts the attempt and retries; direct sends answer { ok: false }. */
export class EmailNotConfiguredError extends Error {
  readonly code = "email_not_configured";
  constructor() {
    super("Email delivery is not configured.");
    this.name = "EmailNotConfiguredError";
  }
}

/** A pooled transport is closed this long after it was replaced, so sends in flight on it can finish. */
const RETIRE_AFTER_MS = 60_000;

let override: EmailTransport | null = null;
let current: { fingerprint: string; transport: Promise<EmailTransport> } | null = null;

/** Replaces the transport (tests). Pass null to go back to the effective configuration's. */
export function setEmailTransport(transport: EmailTransport | null): void {
  override = transport;
}

/** A transport for a configuration: pooled for the process-wide one, single-use (closed by the caller) for probes. */
export async function createEmailTransport(config: EmailConfig, opts: { pool?: boolean } = {}): Promise<EmailTransport> {
  if (config.transport === "smtp") {
    const { createSmtpTransport, smtpOptions } = await import("./transports/smtp");
    return createSmtpTransport(smtpOptions(config, { production: isProduction(), pool: opts.pool ?? true }), config.from);
  }
  if (config.transport === "ses") {
    const { createSesTransport } = await import("./transports/ses");
    return createSesTransport(config);
  }
  const { createConsoleTransport } = await import("./transports/console");
  return createConsoleTransport();
}

function retire(transport: Promise<EmailTransport>): void {
  const timer = setTimeout(() => {
    transport.then((t) => t.close?.()).catch(() => undefined);
  }, RETIRE_AFTER_MS);
  timer.unref?.();
}

/** The process-wide transport of the effective configuration. Throws EmailNotConfiguredError when there is none. */
export async function getEmailTransport(): Promise<EmailTransport> {
  if (override) return override;
  const resolved = await resolveEmail();
  if (resolved.source === "none") throw new EmailNotConfiguredError();
  if (current?.fingerprint !== resolved.fingerprint) {
    if (current) retire(current.transport);
    const transport = createEmailTransport(resolved.config, { pool: true });
    const entry = { fingerprint: resolved.fingerprint, transport };
    current = entry;
    transport.catch(() => {
      if (current === entry) current = null;
    });
  }
  return current.transport;
}

/** Log fields that point developers to /dev/mailbox when the console transport is in use. */
export function mailboxHint(transport: EmailTransport): { mailbox?: string } {
  return transport.name === "console" ? { mailbox: "/dev/mailbox" } : {};
}

/** "pr***@example.com": enough to tell recipients apart in logs without storing the address. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address.slice(0, Math.min(2, at))}***${address.slice(at)}`;
}

/**
 * Name and codes of a send error, never its message (SMTP replies and SES errors can echo addresses). AWS errors carry
 * their exception name (MessageRejected, ...) and the HTTP status of the API call.
 */
export function sendErrorSummary(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { name: typeof error };
  const out: Record<string, string | number> = { name: error.name };
  const { code, responseCode, command, $metadata } = error as { code?: unknown; responseCode?: unknown; command?: unknown; $metadata?: { httpStatusCode?: unknown } };
  // "errorCode": the logger redacts any field named like "code".
  if (typeof code === "string" || typeof code === "number") out.errorCode = code;
  if (typeof responseCode === "number") out.smtpStatus = responseCode;
  if (typeof command === "string") out.smtpCommand = command.split(" ")[0] ?? command;
  if (typeof $metadata?.httpStatusCode === "number") out.httpStatus = $metadata.httpStatusCode;
  return out;
}
