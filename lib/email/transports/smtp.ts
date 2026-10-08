/**
 * SMTP transport (nodemailer 10). The configuration is the effective email configuration (Admin > Settings >
 * Integrations, else the env fallback; lib/integrations/resolver.ts). Security "tls" is implicit TLS (port 465);
 * "starttls" upgrades with STARTTLS, which is required in production. Timeouts keep a stuck server from holding a
 * request or the dispatcher for long. In production every connection goes through the SSRF guard
 * (lib/security/net-guard.ts smtpSocketGuard): the host's addresses are checked and the socket opened to a checked one,
 * while SNI and the certificate check still use the host name.
 * The From is handed to nodemailer as { name, address }, never a concatenated string. Every message is marked
 * Auto-Submitted so autoresponders do not reply to it.
 */
import "server-only";
import { createTransport } from "nodemailer";
import type { EmailConfig } from "@/lib/integrations/types";
import { smtpSocketGuard } from "@/lib/security/net-guard";
import type { EmailTransport } from "../transport";

type TransportOptions = NonNullable<Parameters<typeof createTransport>[0]>;
export type SmtpConfig = Extract<EmailConfig, { transport: "smtp" }>;

export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 } as const;

/** nodemailer options for a configuration. `pool`: the process-wide transport keeps up to 3 connections. */
export function smtpOptions(config: SmtpConfig, opts: { production: boolean; pool: boolean }): TransportOptions {
  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls" && opts.production,
    auth: config.auth ? { user: config.auth.user, pass: config.auth.pass } : undefined,
    ...SMTP_TIMEOUTS,
  };
  if (opts.pool) Object.assign(options, { pool: true, maxConnections: 3 });
  if (opts.production) options.getSocket = smtpSocketGuard({ connectTimeoutMs: SMTP_TIMEOUTS.connectionTimeout });
  return options as TransportOptions;
}

/** A transport around nodemailer. `options` may be any nodemailer transport config (tests pass jsonTransport). */
export function createSmtpTransport(options: TransportOptions, from: { name: string; address: string }): EmailTransport {
  const mailer = createTransport(options);
  return {
    name: "smtp",
    async send(message) {
      const info = (await mailer.sendMail({
        from: { name: from.name, address: from.address },
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: { "Auto-Submitted": "auto-generated", "X-Axs-Template": message.templateId },
      })) as { messageId?: unknown };
      return { messageId: typeof info.messageId === "string" ? info.messageId : "" };
    },
    close() {
      mailer.close();
    },
  };
}
