/**
 * Copy for /contact (Contact.dc.html): contact and demo modes, form labels, success state and the aside.
 * Validation messages live in lib/validation/lead.ts (shared with POST /api/contact).
 *
 * Deliberate change (docs/decisions.md > Phase 2): the prototype's pre-ticked "You can contact me by phone or email
 * about this request" checkbox is now a plain notice (replying to the request needs no extra consent), and the only
 * checkbox is an unticked marketing opt-in (DPDP).
 */

export type ContactMode = "demo" | "contact";

export const CONTACT_META = {
  title: "Contact & demo",
  description: "Request a guided demo or contact Axiomatic Software Solutions for sales and support.",
  path: "/contact",
} as const;

export type ContactModeCopy = {
  /** Breadcrumb current page. */
  crumb: string;
  title: string;
  lede: string;
  /** Mode switch option. */
  tab: string;
  cta: string;
  sentTitle: string;
};

export const CONTACT_MODES: Readonly<Record<ContactMode, ContactModeCopy>> = {
  demo: {
    crumb: "Request a demo",
    title: "Request a demo",
    lede: "See the software working with your own items on a short video call. We’ll confirm the slot by phone or email.",
    tab: "Request a demo",
    cta: "Request demo",
    sentTitle: "Demo requested",
  },
  contact: {
    crumb: "Contact",
    title: "Contact us",
    lede: "Questions about products, licenses or partnerships. Existing customers get faster help through a support ticket.",
    tab: "Contact us",
    cta: "Send message",
    sentTitle: "Message received",
  },
};

/** Mode switch order (prototype). */
export const CONTACT_MODE_ORDER: readonly ContactMode[] = ["demo", "contact"];

export const CONTACT_FIELDS = {
  name: "Your name",
  businessName: "Business name",
  email: "Email",
  phoneDemo: "Mobile number",
  phoneDemoPlaceholder: "98xxxxxxxx",
  phoneContact: "Phone",
  product: "Software",
  productPlaceholder: "Choose software",
  productNotSure: "Not sure yet",
  counters: "Number of billing counters",
  countersPlaceholder: "Select",
  preferredDate: "Preferred date",
  preferredSlot: "Preferred time",
  topic: "Topic",
  demoMessage: "Anything we should know?",
  demoMessagePlaceholder: "e.g. We use another billing software today and want to move our item list.",
  contactMessage: "Message",
  contactMessagePlaceholder: "How can we help?",
  optional: "Optional",
} as const;

export const CONTACT_COPY = {
  breadcrumbHome: "Home",
  modeGroupLabel: "Form type",
  sending: "Sending…",
  sendAnother: "Send another",
  /** Prototype: "Reference {ref} · prototype only, nothing was sent." (the prototype-only part is dropped). */
  reference: (reference: string) => `Reference ${reference}`,
  demoSentBody: (phone: string, date: string | null, slot: string) =>
    `We’ll call ${phone || "you"} to confirm a time on ${date ?? "your chosen day"} (${slot.toLowerCase()}).`,
  contactSentBody: (email: string) => `We usually reply within one business day to ${email}.`,
  /** Marketing opt-in: unticked by default, never required. */
  marketingOptIn: "Also send me occasional product news and offers by email. You can unsubscribe at any time.",
  /** Replaces the prototype's consent checkbox; followed by a link to the privacy policy. */
  noticeBeforeLink: "We’ll contact you by phone or email about this request. See our ",
  noticeLink: "privacy policy",
  noticeAfterLink: ".",
  privacyHref: "/legal/privacy",
  /** Hidden honeypot field label (screen readers never reach it; the wrapper is aria-hidden). */
  honeypotLabel: "Leave this field empty",
} as const;

export const DEMO_STEPS = {
  title: "What happens in a demo",
  steps: [
    "A 30-minute video call at a time you choose.",
    "We bill a few of your real items in the software.",
    "We answer licensing and setup questions.",
  ],
} as const;

export const REACH_US = {
  title: "Other ways to reach us",
  salesCaption: "Sales and demos",
  supportCaptionBefore: "Existing customers · or ",
  supportCaptionLink: "raise a ticket",
  ticketHref: "/account/tickets/new",
  /** Shown while the business details are samples (settings.business.sample). */
  sampleNote: "Contact details are placeholders and configurable.",
} as const;

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "2026-10-14" -> "14 October" (the prototype's en-IN day + long month), or null when not a date. */
export function formatDayMonth(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const month = MONTHS_LONG[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : null;
}
