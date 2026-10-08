/**
 * Email module (server-only). Contract (docs/decisions.md > Phase 3 > Email):
 * - sendAuthEmail({ to, templateId, vars }): auth and invitation emails (codes and links), rendered and sent now, never
 *   stored, never throws.
 * - enqueueEmail(tx, { to, templateId, vars, dedupeKey?, sendAfter? }): business emails via the outbox, inside the
 *   caller's transaction; then kickEmailDispatch() after commit. dispatchPendingEmails() is also run by
 *   /api/cron/emails.
 * Templates: NotificationTemplate row when active, else the code defaults (lib/email/defaults.ts), `{{var}}`
 * placeholders, branded layout (lib/email/layout.ts). Transports: console (dev, /dev/mailbox), SMTP or Amazon SES (API).
 */
import "server-only";

export { sendAuthEmail, AUTH_EMAIL_TIMEOUT_MS, type AuthEmailInput } from "./send";
export {
  enqueueEmail,
  dispatchPendingEmails,
  kickEmailDispatch,
  outboxBackoffMs,
  setEmailAutoDispatch,
  waitForEmailDispatch,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_LEASE_MS,
  type EnqueueEmailInput,
  type DispatchOptions,
} from "./outbox";
export { composeEmail, normalizeRecipient, EmailTemplateError, type ComposedEmail, type ComposeOptions } from "./compose";
export {
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_IDS,
  AUTH_EMAIL_TEMPLATE_IDS,
  BUSINESS_EMAIL_TEMPLATE_IDS,
  DIRECT_EMAIL_TEMPLATE_IDS,
  LINK_EMAIL_TEMPLATE_IDS,
  isEmailTemplateId,
  isAuthEmailTemplateId,
  isDirectEmailTemplateId,
  type EmailTemplateId,
  type AuthEmailTemplateId,
  type DirectEmailTemplateId,
  type BusinessEmailTemplateId,
  type EmailTemplateDefault,
  type EmailBlock,
} from "./defaults";
export { setEmailTransport, getEmailTransport, type EmailTransport, type OutgoingEmail } from "./transport";
