/**
 * Direct sending for auth emails (verification code, password reset link, sign-in code) and invitation emails (team and
 * staff invitation links). They are rendered and sent immediately and never stored: the outbox would persist the code
 * or link. Never throws; failures are logged with the
 * template id and error codes only (no address, subject, code or link).
 */
import "server-only";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { composeEmail, EmailTemplateError, normalizeRecipient, type ComposedEmail } from "./compose";
import { isDirectEmailTemplateId, type DirectEmailTemplateId } from "./defaults";
import { getEmailTransport, mailboxHint, maskEmail, sendErrorSummary } from "./transport";

export type AuthEmailInput = {
  to: string;
  templateId: DirectEmailTemplateId;
  vars: Record<string, string>;
};

/** Upper bound for one auth email, so a slow mail server cannot hold the request for long. */
export const AUTH_EMAIL_TIMEOUT_MS = 15_000;

class SendTimeoutError extends Error {
  constructor() {
    super("Email send timed out.");
    this.name = "SendTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function composeAuthEmail(templateId: DirectEmailTemplateId, vars: Record<string, string>): Promise<ComposedEmail> {
  try {
    return await composeEmail(db, templateId, vars);
  } catch (error) {
    if (error instanceof EmailTemplateError) throw error;
    // Database unavailable: the code defaults and default footer still get the code to the user.
    log.warn("email_template_fallback", { template: templateId, error: sendErrorSummary(error) });
    return composeEmail(null, templateId, vars);
  }
}

/** Renders and sends an auth email now. Resolves { ok: false } on any problem; never throws. */
export async function sendAuthEmail(input: AuthEmailInput): Promise<{ ok: boolean }> {
  const templateId: string = input.templateId;
  try {
    if (!isDirectEmailTemplateId(templateId)) {
      log.error("email_auth_template_invalid", { template: templateId });
      return { ok: false };
    }
    const to = normalizeRecipient(input.to);
    if (!to) {
      log.warn("email_recipient_invalid", { template: templateId });
      return { ok: false };
    }
    const email = await composeAuthEmail(templateId, input.vars);
    if (email.missingVars.length > 0) {
      log.error("email_missing_vars", { template: templateId, names: email.missingVars });
      return { ok: false };
    }
    const transport = await getEmailTransport();
    const result = await withTimeout(
      transport.send({ to, subject: email.subject, html: email.html, text: email.text, templateId }),
      AUTH_EMAIL_TIMEOUT_MS,
    );
    log.info("email_sent", {
      template: templateId,
      transport: transport.name,
      to: maskEmail(to),
      messageId: result.messageId,
      ...mailboxHint(transport),
    });
    return { ok: true };
  } catch (error) {
    log.error("email_send_failed", { template: templateId, error: sendErrorSummary(error) });
    return { ok: false };
  }
}
