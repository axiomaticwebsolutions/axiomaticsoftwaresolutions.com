/**
 * The email transport chosen by EMAIL_TRANSPORT: "console" (development; logs a summary and keeps the message for
 * /dev/mailbox) or "smtp" (nodemailer). Tests replace it with setEmailTransport().
 */
import "server-only";
import { getEnv } from "@/lib/env";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** For logs and the X-Axs-Template header; never the content. */
  templateId: string;
};

export type EmailSendResult = { messageId: string };

export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail): Promise<EmailSendResult>;
}

let override: EmailTransport | null = null;
let selected: Promise<EmailTransport> | null = null;

/** Replaces the transport (tests). Pass null to go back to the one EMAIL_TRANSPORT selects. */
export function setEmailTransport(transport: EmailTransport | null): void {
  override = transport;
}

async function createFromEnv(): Promise<EmailTransport> {
  const env = getEnv();
  if (env.EMAIL_TRANSPORT === "smtp") {
    const { createSmtpTransport, smtpOptionsFromEnv } = await import("./transports/smtp");
    return createSmtpTransport(smtpOptionsFromEnv(env), env.EMAIL_FROM);
  }
  const { createConsoleTransport } = await import("./transports/console");
  return createConsoleTransport();
}

/** The process-wide transport (created once; an SMTP transport keeps a small connection pool). */
export function getEmailTransport(): Promise<EmailTransport> {
  if (override) return Promise.resolve(override);
  if (!selected) {
    selected = createFromEnv().catch((error: unknown) => {
      selected = null;
      throw error;
    });
  }
  return selected;
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

/** Name and codes of a send error, never its message (SMTP replies can echo addresses). */
export function sendErrorSummary(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { name: typeof error };
  const out: Record<string, string | number> = { name: error.name };
  const { code, responseCode, command } = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  // "errorCode": the logger redacts any field named like "code".
  if (typeof code === "string" || typeof code === "number") out.errorCode = code;
  if (typeof responseCode === "number") out.smtpStatus = responseCode;
  if (typeof command === "string") out.smtpCommand = command.split(" ")[0] ?? command;
  return out;
}
