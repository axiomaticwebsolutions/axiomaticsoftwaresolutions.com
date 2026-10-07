/**
 * Email templates: ids, variables and the code defaults (docs/decisions.md > Phase 3 > Email).
 *
 * Every template has two parts:
 * - Copy: `subject` and `body` (plain text, `{{var}}` placeholders, paragraphs separated by a blank line). Admins edit
 *   it in Admin > Templates (NotificationTemplate row); while no active row exists, the copy below is used.
 * - Blocks: the code box, the call-to-action button, order details and small print. They are defined here only, so an
 *   edited body can never lose the verification code or the reset link. They are placed before the closing paragraph.
 *
 * Auth templates (verification code, reset link, sign-in code) and invitation emails (team and staff invitation links)
 * are sent directly and never stored (DIRECT_EMAIL_TEMPLATE_IDS); every other template goes through the outbox. Emails never contain full license keys (only the last 4 characters).
 * Pure module (no server imports), so admin previews and tests can use it.
 */

export const AUTH_EMAIL_TEMPLATE_IDS = ["email_verification", "password_reset", "login_code"] as const;
export type AuthEmailTemplateId = (typeof AUTH_EMAIL_TEMPLATE_IDS)[number];

export const BUSINESS_EMAIL_TEMPLATE_IDS = [
  "order_confirmation",
  "payment_failed",
  "license_issued",
  "renewal_30",
  "renewal_7",
  "license_expired",
  "ticket_reply",
  "lead_received",
  "lead_new",
  "team_invite",
  "staff_invite",
  "refund_issued",
  "release_available",
] as const;
export type BusinessEmailTemplateId = (typeof BUSINESS_EMAIL_TEMPLATE_IDS)[number];

/**
 * Invitation emails carry a bearer link (team access for customers, console access for staff). Like auth emails they
 * are rendered and sent directly after the inviting transaction commits and never written to the outbox, so a read of
 * the database (a replica, a backup) never yields a working link. A failed send is fixed with "Resend" (a new link).
 */
export const LINK_EMAIL_TEMPLATE_IDS = ["team_invite", "staff_invite"] as const satisfies readonly BusinessEmailTemplateId[];

/** Templates sent with sendAuthEmail() (rendered and sent now, never stored). */
export type DirectEmailTemplateId = AuthEmailTemplateId | (typeof LINK_EMAIL_TEMPLATE_IDS)[number];
export const DIRECT_EMAIL_TEMPLATE_IDS: readonly DirectEmailTemplateId[] = [...AUTH_EMAIL_TEMPLATE_IDS, ...LINK_EMAIL_TEMPLATE_IDS];

export type EmailTemplateId = AuthEmailTemplateId | BusinessEmailTemplateId;

export const EMAIL_TEMPLATE_IDS: readonly EmailTemplateId[] = [...BUSINESS_EMAIL_TEMPLATE_IDS, ...AUTH_EMAIL_TEMPLATE_IDS];

/**
 * Code-defined parts of an email. A block whose variable is missing or blank is left out (details rows one by one);
 * variables an email cannot do without are listed in `required` instead.
 */
export type EmailBlock =
  /** A one-time code in a large monospace box. */
  | { kind: "code"; label: string; var: string }
  /** A button linking to an http(s) URL variable, with the plain link underneath as a fallback. */
  | { kind: "button"; label: string; urlVar: string }
  /** Label/value rows (order number, invoice, total, lead details). */
  | { kind: "details"; rows: ReadonlyArray<{ label: string; var: string }> }
  /** Multi-line text from a variable (a visitor's message), shown in a box. */
  | { kind: "quote"; label: string; var: string }
  /** Small print; may contain `{{var}}` placeholders. */
  | { kind: "note"; text: string };

export type EmailTemplateDefault = {
  id: EmailTemplateId;
  /** Admin list name. */
  name: string;
  subject: string;
  body: string;
  /** Variables the email is useless without. */
  required: readonly string[];
  /** Every variable the template understands (admin hint and preview). */
  vars: readonly string[];
  blocks: readonly EmailBlock[];
  /** Realistic values for previews, the dev mailbox and tests. */
  sampleVars: Readonly<Record<string, string>>;
};

const SIGN_OFF = "Thanks,\nAxiomatic Software Solutions";

const ORDER_SAMPLE = {
  customer_name: "Priya Sharma",
  order_id: "AX-10312",
  order_url: "https://axiomaticsoftwaresolutions.com/orders/AX-10312?t=sample",
} as const;

const RENEWAL_SAMPLE = {
  customer_name: "Priya Sharma",
  product_name: "Medical Billing",
  expiry_date: "15 Nov 2026",
  renew_url: "https://axiomaticsoftwaresolutions.com/account/licenses",
} as const;

const DEFAULTS: readonly EmailTemplateDefault[] = [
  {
    id: "order_confirmation",
    name: "Order confirmation",
    subject: "Your order {{order_id}} is confirmed",
    body:
      "Hi {{customer_name}},\n\nThanks for your purchase. We’ve received your payment for order {{order_id}}, and your " +
      "tax invoice is ready on the order page.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "order_id", "order_url"],
    vars: ["customer_name", "order_id", "order_url", "total", "invoice_number"],
    blocks: [
      {
        kind: "details",
        rows: [
          { label: "Order", var: "order_id" },
          { label: "Invoice", var: "invoice_number" },
          { label: "Total paid", var: "total" },
        ],
      },
      { kind: "button", label: "View your order", urlVar: "order_url" },
      { kind: "note", text: "License keys are shown on the order page and in your account, never in email." },
    ],
    sampleVars: { ...ORDER_SAMPLE, total: "₹5,898.82", invoice_number: "AXS/26-27/1181" },
  },
  {
    id: "payment_failed",
    name: "Payment failed",
    subject: "Payment for {{order_id}} didn’t go through",
    body:
      "Hi {{customer_name}},\n\nYour payment for order {{order_id}} didn’t go through, so no license was issued. " +
      "You can try again from the order page.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "order_id", "order_url"],
    vars: ["customer_name", "order_id", "order_url"],
    blocks: [
      { kind: "button", label: "Try the payment again", urlVar: "order_url" },
      {
        kind: "note",
        text: "If your account was charged for this attempt, the amount is returned to it automatically, usually within 5–7 working days.",
      },
    ],
    sampleVars: { ...ORDER_SAMPLE },
  },
  {
    id: "license_issued",
    name: "License issued",
    subject: "Your {{product_name}} license key",
    body:
      "Hi {{customer_name}},\n\nYour {{product_name}} license from order {{order_id}} is ready. Its key ends in " +
      "{{key_last4}}.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "product_name", "order_id", "order_url"],
    vars: ["customer_name", "product_name", "order_id", "order_url", "key_last4"],
    blocks: [
      { kind: "button", label: "View your license key", urlVar: "order_url" },
      {
        kind: "note",
        text:
          "For your security we never send license keys by email. Open the order page to copy the key, or find it " +
          "later under Licenses in your account.",
      },
    ],
    sampleVars: { ...ORDER_SAMPLE, product_name: "Medical Billing", key_last4: "K8NM" },
  },
  {
    id: "renewal_30",
    name: "Renewal reminder · 30 days",
    subject: "{{product_name}} expires on {{expiry_date}} - renew to keep billing",
    body:
      "Hi {{customer_name}},\n\nYour {{product_name}} license expires on {{expiry_date}}. Renew it before then to keep " +
      "receiving updates and support. Renewals are manual, so nothing is charged automatically.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "product_name", "expiry_date"],
    vars: ["customer_name", "product_name", "expiry_date", "renew_url"],
    blocks: [{ kind: "button", label: "Renew now", urlVar: "renew_url" }],
    sampleVars: { ...RENEWAL_SAMPLE },
  },
  {
    id: "renewal_7",
    name: "Renewal reminder · 7 days",
    subject: "7 days left on {{product_name}}",
    body:
      "Hi {{customer_name}},\n\nYour {{product_name}} license expires on {{expiry_date}}. Renew it now to keep " +
      "receiving updates and support without a break.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "product_name", "expiry_date"],
    vars: ["customer_name", "product_name", "expiry_date", "renew_url"],
    blocks: [{ kind: "button", label: "Renew now", urlVar: "renew_url" }],
    sampleVars: { ...RENEWAL_SAMPLE, expiry_date: "14 Oct 2026" },
  },
  {
    id: "license_expired",
    name: "License expired",
    subject: "Your {{product_name}} license has expired",
    body:
      "Hi {{customer_name}},\n\nYour {{product_name}} license expired on {{expiry_date}}. Renew it from your account to " +
      "get updates and support again.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "product_name"],
    vars: ["customer_name", "product_name", "expiry_date", "renew_url"],
    blocks: [{ kind: "button", label: "Renew now", urlVar: "renew_url" }],
    sampleVars: { ...RENEWAL_SAMPLE, expiry_date: "30 Sep 2026" },
  },
  {
    id: "ticket_reply",
    name: "Ticket reply",
    subject: "New reply on {{ticket_id}}",
    body:
      "Hi {{customer_name}},\n\nOur support team replied to your ticket {{ticket_id}}. Open the ticket to read the " +
      "reply and respond.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "ticket_id"],
    vars: ["customer_name", "ticket_id", "ticket_url"],
    blocks: [{ kind: "button", label: "View the reply", urlVar: "ticket_url" }],
    sampleVars: {
      customer_name: "Priya Sharma",
      ticket_id: "T-2041",
      ticket_url: "https://axiomaticsoftwaresolutions.com/account/tickets/T-2041",
    },
  },
  {
    id: "lead_received",
    name: "Lead acknowledgement",
    subject: "We received your {{kind_label}} ({{reference}})",
    body:
      "Hi {{name}},\n\nThanks for getting in touch. We’ve received your {{kind_label}} and will get back to you within " +
      "one business day. Your reference is {{reference}}.\n\n" +
      SIGN_OFF,
    required: ["name", "reference", "kind_label"],
    vars: ["name", "reference", "kind_label"],
    blocks: [],
    sampleVars: { name: "Asha Rao", reference: "DEMO-1001", kind_label: "demo request" },
  },
  {
    id: "lead_new",
    name: "New lead (internal)",
    subject: "New {{kind_label}}: {{reference}} from {{name}}",
    body:
      "A new {{kind_label}} arrived from the website.\n\nReply to {{email}} within one business day; the sender was " +
      "told to expect an answer by then.",
    required: ["reference", "kind_label", "name", "email"],
    vars: [
      "reference",
      "kind_label",
      "name",
      "email",
      "phone",
      "product",
      "message",
      "business",
      "preferred",
      "counters",
      "topic",
      "marketing",
      "source",
    ],
    blocks: [
      {
        kind: "details",
        rows: [
          { label: "Reference", var: "reference" },
          { label: "Name", var: "name" },
          { label: "Business", var: "business" },
          { label: "Email", var: "email" },
          { label: "Phone", var: "phone" },
          { label: "Product", var: "product" },
          { label: "Preferred time", var: "preferred" },
          { label: "Billing counters", var: "counters" },
          { label: "Topic", var: "topic" },
          { label: "Marketing emails", var: "marketing" },
          { label: "Source", var: "source" },
        ],
      },
      { kind: "quote", label: "Message", var: "message" },
    ],
    sampleVars: {
      reference: "DEMO-1001",
      kind_label: "demo request",
      name: "Asha Rao",
      email: "asha@example.com",
      phone: "98200 00000",
      product: "Medical Billing",
      message: "We run two counters and want to see GST billing.",
      business: "Rao Medicals",
      preferred: "8 Oct 2026, Afternoon (2–5)",
      counters: "2–3",
      topic: "",
      marketing: "No",
      source: "product:medical-billing",
    },
  },
  {
    id: "team_invite",
    name: "Team invitation",
    subject: "{{inviter_name}} invited you to {{account_name}} on Axiomatic",
    body:
      "Hi,\n\n{{inviter_name}} invited you to join {{account_name}} on Axiomatic Software Solutions as " +
      "{{role_label}}. Accept the invitation to get your own sign-in, with the access your role allows.\n\n" +
      SIGN_OFF,
    required: ["inviter_name", "account_name", "role_label", "invite_url", "expires"],
    vars: ["inviter_name", "account_name", "role_label", "invite_url", "expires"],
    blocks: [
      { kind: "button", label: "Accept invitation", urlVar: "invite_url" },
      {
        kind: "note",
        text: "The invitation expires on {{expires}}. If you weren’t expecting it, you can ignore this email; nothing changes unless you accept.",
      },
    ],
    sampleVars: {
      inviter_name: "Priya Sharma",
      account_name: "Sharma Medicals",
      role_label: "Technical contact",
      invite_url: "https://axiomaticsoftwaresolutions.com/invite?token=sample",
      expires: "14 Oct 2026",
    },
  },
  {
    id: "staff_invite",
    name: "Staff invitation",
    subject: "{{inviter_name}} invited you to the Axiomatic admin console",
    body:
      "Hi,\n\n{{inviter_name}} invited you to the Axiomatic Software Solutions admin console as {{role_label}}. " +
      "Accept the invitation to choose your name and password.\n\n" +
      SIGN_OFF,
    required: ["inviter_name", "role_label", "invite_url", "expires"],
    vars: ["inviter_name", "role_label", "invite_url", "expires"],
    blocks: [
      { kind: "button", label: "Accept invitation", urlVar: "invite_url" },
      {
        kind: "note",
        text: "The invitation expires on {{expires}}. If you weren’t expecting it, you can ignore this email; nothing changes unless you accept.",
      },
    ],
    sampleVars: {
      inviter_name: "Anita Desai",
      role_label: "Support",
      invite_url: "https://axiomaticsoftwaresolutions.com/staff-invite?token=sample",
      expires: "14 Oct 2026",
    },
  },
  {
    id: "refund_issued",
    name: "Refund issued",
    subject: "Refund for order {{order_id}}",
    body:
      "Hi {{customer_name}},\n\nWe’ve refunded {{amount}} for order {{order_id}} to the original payment method. " +
      "Banks usually take 5–7 working days to show it in your account.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "order_id", "amount", "order_url"],
    vars: ["customer_name", "order_id", "order_url", "amount", "credit_note_number", "licenses"],
    blocks: [
      {
        kind: "details",
        rows: [
          { label: "Order", var: "order_id" },
          { label: "Refund", var: "amount" },
          { label: "Credit note", var: "credit_note_number" },
          { label: "Licenses revoked", var: "licenses" },
        ],
      },
      { kind: "button", label: "View your order", urlVar: "order_url" },
    ],
    sampleVars: { ...ORDER_SAMPLE, amount: "₹5,898.82", credit_note_number: "AXC/26-27/0005", licenses: "LIC-24310" },
  },
  {
    id: "release_available",
    name: "Update available",
    subject: "{{product_name}} {{version}} is available",
    body:
      "Hi {{customer_name}},\n\nVersion {{version}} of {{product_name}} is ready to download. Your license includes it, " +
      "so you can update whenever it suits you.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "product_name", "version", "software_url"],
    vars: ["customer_name", "product_name", "version", "software_url"],
    blocks: [
      { kind: "button", label: "Download the update", urlVar: "software_url" },
      {
        kind: "note",
        text: "You get this email because update emails are on. You can turn them off under Notifications in your account.",
      },
    ],
    sampleVars: {
      customer_name: "Priya Sharma",
      product_name: "Medical Store Billing",
      version: "4.2.1",
      software_url: "https://axiomaticsoftwaresolutions.com/account/software",
    },
  },
  {
    id: "email_verification",
    name: "Email verification",
    subject: "Your verification code: {{code}}",
    body: "Hi {{customer_name}},\n\nEnter this code to verify the email address for your Axiomatic account.\n\n" + SIGN_OFF,
    required: ["customer_name", "code"],
    vars: ["customer_name", "code"],
    blocks: [
      { kind: "code", label: "Verification code", var: "code" },
      { kind: "note", text: "The code expires in 15 minutes. If you didn’t create an account, you can ignore this email." },
    ],
    sampleVars: { customer_name: "Priya Sharma", code: "482913" },
  },
  {
    id: "password_reset",
    name: "Password reset",
    subject: "Reset your Axiomatic password",
    body:
      "Hi {{customer_name}},\n\nWe received a request to reset the password for your Axiomatic account. Choose a new " +
      "password with the button below.\n\n" +
      SIGN_OFF,
    required: ["customer_name", "reset_url"],
    vars: ["customer_name", "reset_url"],
    blocks: [
      { kind: "button", label: "Reset password", urlVar: "reset_url" },
      {
        kind: "note",
        text: "The link expires in 30 minutes and works once. If you didn’t ask for this, ignore this email; your password won’t change.",
      },
    ],
    sampleVars: { customer_name: "Priya Sharma", reset_url: "https://axiomaticsoftwaresolutions.com/reset?token=sample" },
  },
  {
    id: "login_code",
    name: "Sign-in code",
    subject: "Your sign-in code: {{code}}",
    body: "Hi {{customer_name}},\n\nEnter this code to finish signing in to your Axiomatic account.\n\n" + SIGN_OFF,
    required: ["customer_name", "code"],
    vars: ["customer_name", "code"],
    blocks: [
      { kind: "code", label: "Sign-in code", var: "code" },
      {
        kind: "note",
        text: "The code expires in 10 minutes. If you didn’t try to sign in, someone may know your password: change it straight away.",
      },
    ],
    sampleVars: { customer_name: "Sneha Iyer", code: "071564" },
  },
];

/** Code defaults by template id. */
export const EMAIL_TEMPLATE_DEFAULTS: Readonly<Record<EmailTemplateId, EmailTemplateDefault>> = Object.freeze(
  Object.fromEntries(DEFAULTS.map((t) => [t.id, t])) as Record<EmailTemplateId, EmailTemplateDefault>,
);

export function isEmailTemplateId(value: string): value is EmailTemplateId {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATE_DEFAULTS, value);
}

export function isAuthEmailTemplateId(value: string): value is AuthEmailTemplateId {
  return (AUTH_EMAIL_TEMPLATE_IDS as readonly string[]).includes(value);
}

/** Auth and invitation templates: sent directly, never stored in the outbox. */
export function isDirectEmailTemplateId(value: string): value is DirectEmailTemplateId {
  return (DIRECT_EMAIL_TEMPLATE_IDS as readonly string[]).includes(value);
}

/** Required variables that are missing or blank. */
export function missingRequiredVars(
  required: readonly string[],
  vars: Readonly<Record<string, string | undefined>>,
): string[] {
  return required.filter((name) => {
    const value = vars[name];
    return typeof value !== "string" || value.trim() === "";
  });
}
