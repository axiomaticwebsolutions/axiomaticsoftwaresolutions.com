/**
 * Admin Notification templates (Admin Console.dc.html #templates; decisions.md Phase 3 "Email" and Phase 6): the DTO,
 * statuses, triggers, variable checks, the live preview through the email renderer and the list URL contract.
 * Pure and client-safe (lib/email/defaults and lib/email/render are pure).
 *
 * A template's copy (subject + body) comes from its NotificationTemplate row while the row is active. A draft row, or
 * no row at all, sends the code default (lib/email/defaults.ts), so a draft never stops an email. Code boxes, buttons,
 * order details and small print are code blocks the editor cannot remove.
 */
import type { ListQuerySpec } from "@/lib/admin/list-query";
import type { EmailLogo } from "@/lib/branding/model";
import { attachmentKindsFor, type EmailAttachmentKind } from "@/lib/email/attachment-refs";
import {
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_IDS,
  isDirectEmailTemplateId,
  isEmailTemplateId,
  type EmailTemplateId,
} from "@/lib/email/defaults";
import type { EmailFooter } from "@/lib/email/layout";
import { MAX_SUBJECT_LENGTH, renderEmail, templateVarNames, type RenderedEmail } from "@/lib/email/render";
import { defineListState } from "@/lib/url-state";

export { relativeAgo } from "./relative";

/** active: the row's copy is sent; draft: the row exists but the code default is sent; default: no row yet. */
export const TEMPLATE_STATUSES = ["active", "draft", "default"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_STATUS_LABELS: Readonly<Record<TemplateStatus, string>> = { active: "Active", draft: "Draft", default: "Built-in" };

export const TEMPLATE_BODY_MAX = 10_000;

/** When each email goes out (new copy; the prototype showed the id with spaces, still the fallback for new ids). */
export const TEMPLATE_TRIGGERS: Readonly<Partial<Record<EmailTemplateId, string>>> = {
  order_confirmation: "An order is paid",
  payment_failed: "A payment attempt fails",
  license_issued: "A license is issued",
  renewal_30: "30 days before a license ends",
  renewal_7: "7 days before a license ends",
  license_expired: "A license has ended",
  ticket_reply: "Staff reply to a ticket",
  lead_received: "Contact or demo form sent (to the visitor)",
  lead_new: "Contact, demo or waitlist form sent (to sales)",
  team_invite: "A customer invites a team member",
  staff_invite: "The owner invites a staff member",
  refund_issued: "A refund is issued",
  release_available: "A new release is published",
  account_email_changed: "Staff change a customer’s sign-in email (sent to the old address)",
  order_payment_link: "Staff create an order or share its payment link",
  email_verification: "Sign-up and email verification",
  password_reset: "Forgot password",
  login_code: "Two-step sign-in",
  set_password: "Staff create a customer or a set-password link",
};

export type TemplateDto = {
  id: string;
  name: string;
  channel: "Email";
  /** The copy shown in the editor: the row's, or the code default when there is no row. */
  subject: string;
  body: string;
  active: boolean;
  status: TemplateStatus;
  /** Row update time; null for built-in templates without a row. */
  updatedAt: string | null;
  trigger: string;
  /** Variables the template understands (chips in the editor). */
  vars: string[];
  /** Variables the email cannot do without (filled by the app, never typed). */
  required: string[];
  /** Auth and invitation emails (codes, reset and invitation links) are sent directly, never through the outbox. */
  auth: boolean;
  /**
   * What the app attaches when the email is sent (order_confirmation: the tax invoice PDF), or null. Code-defined
   * (lib/email/attachment-refs.ts), independent of the copy; previews and test sends carry no attachment.
   */
  attachmentNote: string | null;
  defaultSubject: string | null;
  defaultBody: string | null;
};

export type TemplateRowInput = { name: string; subject: string; body: string; active: boolean; updatedAt: Date } | null;

const ATTACHMENT_KIND_NOTES: Readonly<Record<EmailAttachmentKind, string>> = {
  invoice: "The order\u2019s tax invoice is attached as a PDF automatically when the email is sent. Previews and test emails don\u2019t include it.",
};

/** The attachment note of a template (Admin > Notification templates), or null when it has no attachments. */
export function templateAttachmentNote(id: string): string | null {
  const kinds = attachmentKindsFor(id);
  return kinds.length > 0 ? kinds.map((k) => ATTACHMENT_KIND_NOTES[k]).join(" ") : null;
}

/** The DTO of a template from its row (or null) and the code default (or null for a row without one). */
export function templateDto(id: string, row: TemplateRowInput): TemplateDto {
  const def = isEmailTemplateId(id) ? EMAIL_TEMPLATE_DEFAULTS[id] : null;
  return {
    id,
    name: row?.name ?? def?.name ?? id,
    channel: "Email",
    subject: row?.subject ?? def?.subject ?? "",
    body: row?.body ?? def?.body ?? "",
    active: row ? row.active : true,
    status: row ? (row.active ? "active" : "draft") : "default",
    updatedAt: row?.updatedAt.toISOString() ?? null,
    trigger: (isEmailTemplateId(id) ? TEMPLATE_TRIGGERS[id] : undefined) ?? id.replace(/_/g, " "),
    vars: def ? [...def.vars] : [],
    required: def ? [...def.required] : [],
    auth: isDirectEmailTemplateId(id),
    attachmentNote: templateAttachmentNote(id),
    defaultSubject: def?.subject ?? null,
    defaultBody: def?.body ?? null,
  };
}

/** Every known template id in catalogue order (business emails, then auth emails), then any other stored ids. */
export function templateOrder(ids: readonly string[]): string[] {
  const extra = ids.filter((id) => !isEmailTemplateId(id)).sort();
  return [...EMAIL_TEMPLATE_IDS, ...extra];
}

/** Placeholders in subject and body that the template does not know (they would be blank in production). */
export function unknownTemplateVars(t: { vars: readonly string[] }, subject: string, body: string): string[] {
  const allowed = new Set(t.vars);
  const used = [...new Set([...templateVarNames(subject), ...templateVarNames(body)])];
  return used.filter((name) => !allowed.has(name));
}

export const TEMPLATE_ERRORS = {
  subject: `Write a subject (up to ${MAX_SUBJECT_LENGTH} characters).`,
  body: `Write the email text (up to ${TEMPLATE_BODY_MAX.toLocaleString("en-IN")} characters).`,
  unknownVars: (names: readonly string[]) =>
    `${names.length === 1 ? "This variable isn\u2019t" : "These variables aren\u2019t"} available here: ${names
      .map((n) => `{{${n}}}`)
      .join(", ")}. Use the variables listed above.`,
  nothingToSave: "Change the subject, the text or the status first.",
} as const;

/** `logo`: the uploaded logo (Admin > Settings > Branding), as real emails show it; null or missing = the built-in one. */
export type TemplatePreviewContext = { footer: EmailFooter; appUrl: string; logo?: EmailLogo | null };

/**
 * The email as it would be sent with the template's sample data (lib/email/defaults sampleVars), through the same
 * renderer as real emails. Unknown placeholders stay visible.
 */
export function previewTemplate(id: string, content: { subject: string; body: string }, ctx: TemplatePreviewContext): RenderedEmail {
  const def = isEmailTemplateId(id) ? EMAIL_TEMPLATE_DEFAULTS[id] : null;
  return renderEmail({
    subject: content.subject,
    body: content.body,
    blocks: def?.blocks ?? [],
    vars: def?.sampleVars ?? {},
    footer: ctx.footer,
    appUrl: ctx.appUrl,
    logo: ctx.logo,
    unknownVars: "keep",
  });
}

/** Prototype preview text: "Subject: ...", a blank line, then the plain-text email (blocks included). */
export function previewText(rendered: RenderedEmail): string {
  return `Subject: ${rendered.subject}\n\n${rendered.text}`;
}

// ---------- List URL contract (?q=&filter[status]=&sort=) ----------

export const TEMPLATE_SORTS = ["order", "name", "updated"] as const;
export type TemplateSort = (typeof TEMPLATE_SORTS)[number];

export const TEMPLATES_LIST = defineListState<"status">({
  filterStyle: "bracket",
  filters: { status: { values: TEMPLATE_STATUSES } },
  sortable: TEMPLATE_SORTS,
  defaultSort: { id: "order", desc: false },
  pageSize: 25,
});

export const TEMPLATE_LIST_SPEC = {
  filters: { status: TEMPLATE_STATUSES },
  sortable: TEMPLATE_SORTS,
  defaultSort: { id: "order", desc: false },
  defaultPageSize: 25,
} satisfies ListQuerySpec<{ status: typeof TEMPLATE_STATUSES }, TemplateSort>;

export type TemplateListQuery = { q: string; filters: { status?: TemplateStatus }; sort: { id: TemplateSort; desc: boolean } };

export function filterAndSortTemplates(rows: readonly TemplateDto[], query: TemplateListQuery): TemplateDto[] {
  const q = query.q.trim().toLowerCase();
  const order = new Map(templateOrder(rows.map((r) => r.id)).map((id, i) => [id, i]));
  const rank = (t: TemplateDto) => order.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  const dir = query.sort.desc ? -1 : 1;
  const compare: Record<TemplateSort, (a: TemplateDto, b: TemplateDto) => number> = {
    order: (a, b) => rank(a) - rank(b),
    name: (a, b) => a.name.localeCompare(b.name),
    updated: (a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
  };
  return rows
    .filter(
      (t) =>
        (!query.filters.status || t.status === query.filters.status) &&
        (!q || `${t.name} ${t.id} ${t.subject}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => dir * (compare[query.sort.id](a, b) || rank(a) - rank(b)));
}

export const TEMPLATE_COPY = {
  searchPlaceholder: "Search name, id or subject",
  searchLabel: "Search templates",
  caption: "Notification templates",
  saved: "Changes saved",
  noChanges: "No changes to save",
  statusUpdated: "Template updated",
  testSent: (email: string) => `Test email sent to ${email}`,
  draftNote: "Draft: emails use the built-in copy until you activate it.",
  builtInNote: "Not edited yet: emails use the built-in copy shown here. Saving makes it editable.",
  authNote: "Sent straight away and never stored. The app adds the code or link.",
  blocksNote: "The app adds buttons, codes and order details, so editing the text can\u2019t remove them.",
  varsHint: "Click a variable to insert it where the cursor is.",
} as const;
