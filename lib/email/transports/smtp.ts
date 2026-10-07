/**
 * SMTP transport (nodemailer 10, pooled). Port 465 uses implicit TLS; other ports upgrade with STARTTLS, which is
 * required in production. Timeouts keep a stuck server from holding a request or the dispatcher for long.
 * The From address is EMAIL_FROM. Every message is marked Auto-Submitted so autoresponders do not reply to it.
 */
import "server-only";
import { createTransport } from "nodemailer";
import type { Env } from "@/lib/env";
import type { EmailTransport } from "../transport";

type TransportOptions = NonNullable<Parameters<typeof createTransport>[0]>;

export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 } as const;

/** Pooled SMTP options from the environment. */
export function smtpOptionsFromEnv(
  env: Pick<Env, "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASSWORD" | "NODE_ENV">,
): TransportOptions {
  const secure = env.SMTP_PORT === 465;
  return {
    pool: true,
    maxConnections: 3,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure,
    requireTLS: !secure && env.NODE_ENV === "production",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined,
    ...SMTP_TIMEOUTS,
  };
}

/** A transport around nodemailer. `options` may be any nodemailer transport config (tests pass jsonTransport). */
export function createSmtpTransport(options: TransportOptions, from: string): EmailTransport {
  const mailer = createTransport(options);
  return {
    name: "smtp",
    async send(message) {
      const info = (await mailer.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: { "Auto-Submitted": "auto-generated", "X-Axs-Template": message.templateId },
      })) as { messageId?: unknown };
      return { messageId: typeof info.messageId === "string" ? info.messageId : "" };
    },
  };
}
