/**
 * Composes a ready-to-send email from a template id and variables: the copy comes from the NotificationTemplate row
 * when it is active, otherwise from the code defaults; blocks and required variables always come from the code
 * defaults; the footer comes from the business settings and the logo from Admin > Settings > Branding (the uploaded
 * light logo's PNG rendition by absolute URL, else the built-in one). Server-only (reads the database).
 */
import "server-only";
import type { EmailLogo } from "@/lib/branding/model";
import { emailLogo } from "@/lib/branding/store";
import { getSetting, SETTING_DEFAULTS, type BusinessSettings } from "@/lib/config";
import type { Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { EMAIL_TEMPLATE_DEFAULTS, isEmailTemplateId, missingRequiredVars, type EmailBlock } from "./defaults";
import type { EmailFooter } from "./layout";
import { renderEmail, type EmailVars, type RenderedEmail, type UnknownVarMode } from "./render";

export type EmailTemplateErrorReason = "unknown_template" | "missing_vars" | "invalid_recipient" | "auth_template" | "invalid_attachments";

/** A programming error in how an email was requested (thrown in development and tests, logged in production). */
export class EmailTemplateError extends Error {
  readonly reason: EmailTemplateErrorReason;
  readonly templateId: string;

  constructor(reason: EmailTemplateErrorReason, templateId: string, message: string) {
    super(message);
    this.name = "EmailTemplateError";
    this.reason = reason;
    this.templateId = templateId;
  }
}

export type ComposedEmail = RenderedEmail & {
  templateId: string;
  /** "template": the active NotificationTemplate row; "default": the code defaults. */
  source: "template" | "default";
  /** Required variables that were missing or blank. */
  missingVars: string[];
};

export type ComposeOptions = {
  /** Unsaved copy to preview (Admin > Templates). */
  content?: { subject: string; body: string };
  business?: BusinessSettings;
  appUrl?: string;
  /** The header logo; default: the uploaded one from the database (none with `db: null`). */
  logo?: EmailLogo | null;
  unknownVars?: UnknownVarMode;
};

const MAX_RECIPIENT_LENGTH = 254;

/** A single plain address ("name@example.com"), trimmed, or null. Rejects lists, display names and header breaks. */
export function normalizeRecipient(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length < 3 || v.length > MAX_RECIPIENT_LENGTH) return null;
  return /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/.test(v) ? v : null;
}

export function footerFromBusiness(business: BusinessSettings): EmailFooter {
  return {
    legalName: business.legalName,
    address: business.address,
    city: business.city,
    state: business.state,
    pin: business.pin,
    supportEmail: business.supportEmail,
  };
}

async function templateContent(
  db: Db | null,
  templateId: string,
): Promise<{ subject: string; body: string; source: ComposedEmail["source"] } | null> {
  if (db) {
    const row = await db.notificationTemplate.findUnique({
      where: { id: templateId },
      select: { subject: true, body: true, active: true },
    });
    if (row?.active) return { subject: row.subject, body: row.body, source: "template" };
  }
  if (isEmailTemplateId(templateId)) {
    const def = EMAIL_TEMPLATE_DEFAULTS[templateId];
    return { subject: def.subject, body: def.body, source: "default" };
  }
  return null;
}

/**
 * Renders `templateId` with `vars`. Pass `db: null` to skip the database (code defaults and default settings), e.g.
 * when it is unavailable. Throws EmailTemplateError("unknown_template") when neither a row nor a default exists.
 * Unknown placeholders are logged (names only).
 */
export async function composeEmail(
  db: Db | null,
  templateId: string,
  vars: EmailVars,
  options: ComposeOptions = {},
): Promise<ComposedEmail> {
  const content = options.content ? { ...options.content, source: "template" as const } : await templateContent(db, templateId);
  if (!content) throw new EmailTemplateError("unknown_template", templateId, `Unknown email template "${templateId}".`);

  const def = isEmailTemplateId(templateId) ? EMAIL_TEMPLATE_DEFAULTS[templateId] : null;
  const blocks: readonly EmailBlock[] = def?.blocks ?? [];
  const business = options.business ?? (db ? await getSetting(db, "business") : structuredClone(SETTING_DEFAULTS.business));
  const appUrl = options.appUrl ?? getEnv().APP_URL;
  const logo = options.logo !== undefined ? options.logo : db ? await emailLogo(db, appUrl) : null;

  const rendered = renderEmail({
    subject: content.subject,
    body: content.body,
    blocks,
    vars,
    footer: footerFromBusiness(business),
    appUrl,
    logo,
    unknownVars: options.unknownVars,
  });
  if (rendered.unknownVars.length > 0) {
    log.warn("email_template_unknown_vars", { template: templateId, source: content.source, names: rendered.unknownVars });
  }
  return { ...rendered, templateId, source: content.source, missingVars: missingRequiredVars(def?.required ?? [], vars) };
}
