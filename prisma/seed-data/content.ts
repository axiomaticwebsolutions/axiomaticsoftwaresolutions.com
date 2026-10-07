/**
 * SAMPLE storefront content, coupons, notification templates and site settings.
 * FAQ copy comes from Home.dc.html, Pricing.dc.html and Support.dc.html (the canonical storefront text, not the shorter
 * admin seed);
 * templates, banner and coupons from the admin seed in axiomatic-data.js.
 */
import { CouponType, PlanType } from "@/generated/prisma/enums";
import type { SiteSettings } from "@/lib/config";
import { addDays, endOfDayIST } from "@/lib/dates";
import type { CouponRule } from "@/lib/pricing";
import type { SeedFaq } from "./catalog";

export const HOME_FAQS: readonly SeedFaq[] = [
  {
    question: "Do I need the internet to use the software?",
    answer:
      "No. Billing works offline. You need an internet connection to activate your license the first time and to download updates.",
  },
  {
    question: "What is the difference between one-time and annual licenses?",
    answer:
      "A one-time license is paid once and works on the version you own indefinitely, with 12 months of updates included. An annual license is renewed every year and includes updates and support for as long as it is active. Not every product offers both.",
  },
  {
    question: "Can I move my license to a new computer?",
    answer:
      "Yes. Deactivate the old computer from your account, then activate the software on the new one with the same key. If the old computer no longer works, our support team can reset it for you.",
  },
  {
    question: "Will I get a GST invoice?",
    answer:
      "Yes. Every purchase includes a downloadable tax invoice. Add your GSTIN at checkout to claim input tax credit.",
  },
  {
    question: "Which payment methods do you accept?",
    answer:
      "UPI, debit and credit cards, and net banking through our payment partner. Your license is issued as soon as the payment is confirmed.",
  },
  {
    question: "Can I get a refund?",
    answer:
      "Refund eligibility depends on the product and license type. Please read our refund policy before purchasing, or start with a free trial where one is available.",
  },
];

/**
 * Pricing.dc.html. The answer about automatic subscription renewal is reworded: v1 has no payment mandates
 * (docs/decisions.md 2), so the prototype's "renew through a payment mandate" promise would be false.
 */
export const PRICING_FAQS: readonly SeedFaq[] = [
  {
    question: "Can I start on a trial and keep my data?",
    answer:
      "Yes. When you buy, activate the same installation with your new key. Your bills, items and settings stay as they are.",
  },
  {
    question: "Can I switch from annual to one-time later?",
    answer: "Yes, where the product offers both. Open the license in your account and choose Renew & upgrade.",
  },
  {
    question: "What counts as a device?",
    answer:
      "Each computer, billing terminal or tablet where the software is activated. You can see and deactivate devices from your account.",
  },
  {
    question: "What if my computer stops working?",
    answer:
      "Deactivate it from your account. If you can’t, our support team can reset your devices after verifying your purchase.",
  },
  {
    question: "Do subscriptions renew automatically?",
    answer:
      "No. Monthly and yearly subscriptions are paid one period at a time. Renew each month or year from your account; nothing is charged automatically. Annual licenses also renew only when you choose to.",
  },
  {
    question: "Do you offer refunds?",
    answer: "Eligibility depends on the product and license type. See the refund policy for details.",
  },
];

/**
 * Support.dc.html "Common questions". Each links to the matching guide (prototype Docs.dc.html#<slug> -> /docs/<slug>).
 */
export const SUPPORT_FAQS: readonly SeedFaq[] = [
  {
    question: "It says “activation limit reached”.",
    answer: "All device slots on the license are in use. Deactivate a computer from your account or add one.",
    href: "/docs/activate",
  },
  {
    question: "My old computer stopped working. How do I move my license?",
    answer: "Raise a ticket and we’ll reset your devices after confirming the purchase. Then activate on the new computer.",
    href: "/docs/move",
  },
  {
    question: "The software says my license expired.",
    answer: "Renew from your account. The software unlocks within a minute of payment being confirmed.",
    href: "/docs/renew",
  },
  {
    question: "I paid but didn’t get a license key.",
    answer:
      "If the payment is pending with your bank, the key is issued automatically once it’s confirmed. Check Orders in your account, or contact support with your order ID.",
    href: "/docs/activate",
  },
  {
    question: "How do I back up my billing data?",
    answer: "Turn on daily backup under Settings → Backup and save to a different drive.",
    href: "/docs/backup",
  },
  {
    question: "My barcode scanner doesn’t type anything.",
    answer: "Check Settings → Devices → Barcode input and switch keyboard mode on.",
    href: "/docs/troubleshooting",
  },
  {
    question: "Can I use the software without internet?",
    answer: "Yes. Activated copies work offline and check in at least every 7 days.",
    href: "/docs/troubleshooting",
  },
];

/** `body` defaults to templateBody(subject); set it when the template's variables differ from the greeting's. */
export type SeedTemplate = { id: string; name: string; subject: string; active: boolean; body?: string };

/**
 * Admin seed order. license_expired is a draft in the prototype, i.e. inactive. Phase 3 adds login_code (two-step
 * sign-in) and the lead emails (lead_received to the visitor, lead_new to the sales address); Phase 5 adds team_invite
 * (portal team invitations); Phase 6 adds refund_issued (admin refunds), staff_invite (admin staff invitations)
 * and release_available (update emails when a release is published).
 * Their copy matches the code defaults in lib/email/defaults.ts.
 */
export const NOTIFICATION_TEMPLATES: readonly SeedTemplate[] = [
  { id: "order_confirmation", name: "Order confirmation", subject: "Your order {{order_id}} is confirmed", active: true },
  { id: "payment_failed", name: "Payment failed", subject: "Payment for {{order_id}} didn’t go through", active: true },
  { id: "license_issued", name: "License issued", subject: "Your {{product_name}} license key", active: true },
  { id: "renewal_30", name: "Renewal reminder · 30 days", subject: "{{product_name}} expires on {{expiry_date}} - renew to keep billing", active: true },
  { id: "renewal_7", name: "Renewal reminder · 7 days", subject: "7 days left on {{product_name}}", active: true },
  { id: "license_expired", name: "License expired", subject: "Your {{product_name}} license has expired", active: false },
  { id: "ticket_reply", name: "Ticket reply", subject: "New reply on {{ticket_id}}", active: true },
  { id: "email_verification", name: "Email verification", subject: "Your verification code: {{code}}", active: true },
  { id: "password_reset", name: "Password reset", subject: "Reset your Axiomatic password", active: true },
  { id: "login_code", name: "Sign-in code", subject: "Your sign-in code: {{code}}", active: true },
  {
    id: "lead_received",
    name: "Lead acknowledgement",
    subject: "We received your {{kind_label}} ({{reference}})",
    body:
      "Hi {{name}},\n\nThanks for getting in touch. We’ve received your {{kind_label}} and will get back to you within " +
      "one business day. Your reference is {{reference}}.\n\nThanks,\nAxiomatic Software Solutions",
    active: true,
  },
  {
    id: "lead_new",
    name: "New lead (internal)",
    subject: "New {{kind_label}}: {{reference}} from {{name}}",
    body:
      "A new {{kind_label}} arrived from the website.\n\nReply to {{email}} within one business day; the sender was " +
      "told to expect an answer by then.",
    active: true,
  },
  {
    id: "team_invite",
    name: "Team invitation",
    subject: "{{inviter_name}} invited you to {{account_name}} on Axiomatic",
    body:
      "Hi,\n\n{{inviter_name}} invited you to join {{account_name}} on Axiomatic Software Solutions as " +
      "{{role_label}}. Accept the invitation to get your own sign-in, with the access your role allows.\n\nThanks,\nAxiomatic Software Solutions",
    active: true,
  },
  {
    id: "staff_invite",
    name: "Staff invitation",
    subject: "{{inviter_name}} invited you to the Axiomatic admin console",
    body:
      "Hi,\n\n{{inviter_name}} invited you to the Axiomatic Software Solutions admin console as {{role_label}}. " +
      "Accept the invitation to choose your name and password.\n\nThanks,\nAxiomatic Software Solutions",
    active: true,
  },
  {
    id: "refund_issued",
    name: "Refund issued",
    subject: "Refund for order {{order_id}}",
    body:
      "Hi {{customer_name}},\n\nWe’ve refunded {{amount}} for order {{order_id}} to the original payment method. " +
      "Banks usually take 5–7 working days to show it in your account.\n\nThanks,\nAxiomatic Software Solutions",
    active: true,
  },
  {
    id: "release_available",
    name: "Update available",
    subject: "{{product_name}} {{version}} is available",
    body:
      "Hi {{customer_name}},\n\nVersion {{version}} of {{product_name}} is ready to download. Your license includes it, " +
      "so you can update whenever it suits you.\n\nThanks,\nAxiomatic Software Solutions",
    active: true,
  },
];

/** The prototype's generated body: greeting, the subject as a sentence, sign-off. */
export function templateBody(subject: string): string {
  return `Hi {{customer_name}},\n\n${subject}.\n\nThanks,\nAxiomatic Software Solutions`;
}

/** Text of the dark strip above the site header (Site Header.dc.html). */
export const SAMPLE_NOTICE_TEXT = "Prototype · Prices, policies and screenshots are sample content and configurable";

/**
 * SiteSetting rows. Seller details are the prototype placeholders (decisions.md 14) flagged sample: true; the
 * prototype has no seller address or PIN, so those are placeholders too. The sales, legal and privacy addresses come
 * from Contact.dc.html and Legal.dc.html. Validated with lib/config settingSchemas.
 */
export const SEED_SETTINGS: SiteSettings = {
  business: {
    legalName: "Axiomatic Software Solutions (placeholder)",
    gstin: "27AAAAA0000A1Z5",
    address: "Registered office address (placeholder)",
    city: "Pune",
    state: "Maharashtra",
    pin: "411001",
    supportEmail: "support@axiomatic.example",
    salesEmail: "sales@axiomatic.example",
    legalEmail: "legal@axiomatic.example",
    privacyEmail: "privacy@axiomatic.example",
    phone: "+91 00000 00000",
    hours: "Mon–Sat, 10:00–19:00 IST",
    sample: true,
  },
  tax: { gstRatePct: 18, sac: "997331", priceDisplay: "exclusive", invoicePrefix: "AXS", creditNotePrefix: "AXC" },
  licensing: { selfServiceResetsPerYear: 3, expiringDays: 60, downloadLinkMinutes: 10 },
  "content.banner": { enabled: false, text: "Diwali offer: 20% off annual licenses with code DIWALI20" },
  "content.sampleNotice": { enabled: true, text: SAMPLE_NOTICE_TEXT },
};

/** Day offsets are relative to the seed run ("ago" negative, "ahead" positive); a string is a fixed IST date. */
type DayOffset = number;

export type SeedCoupon = Omit<CouponRule, "startsAt" | "endsAt"> & { starts: DayOffset; ends: DayOffset | string };

/**
 * Admin seed coupons. Labels come from the checkout list (COUPONS[].label) where present, otherwise they are
 * written from the admin scope text. MONSOON25 keeps its fixed end date so "expired on 31 Aug 2026" stays true.
 */
export const COUPONS: readonly SeedCoupon[] = [
  { code: "WELCOME10", type: CouponType.PERCENT, value: 10, label: "10% off orders above ₹2,000", minSubtotal: 200000, productIds: [], planTypes: [], starts: -90, ends: 60, maxRedemptions: 200, redemptions: 14, active: true },
  { code: "ANNUAL500", type: CouponType.FLAT, value: 50000, label: "₹500 off annual and subscription plans", minSubtotal: null, productIds: [], planTypes: [PlanType.ANNUAL, PlanType.SUBSCRIPTION], starts: -120, ends: 120, maxRedemptions: 500, redemptions: 31, active: true },
  { code: "CHEQUE15", type: CouponType.PERCENT, value: 15, label: "15% off Cheque Printing", minSubtotal: null, productIds: ["cheque-printing"], planTypes: [], starts: -30, ends: 30, maxRedemptions: 100, redemptions: 6, active: true },
  { code: "DIWALI20", type: CouponType.PERCENT, value: 20, label: "20% off annual licenses", minSubtotal: null, productIds: [], planTypes: [PlanType.ANNUAL], starts: 14, ends: 28, maxRedemptions: 300, redemptions: 0, active: true },
  { code: "MONSOON25", type: CouponType.PERCENT, value: 25, label: "Expired sample code", minSubtotal: null, productIds: [], planTypes: [], starts: -120, ends: "2026-08-31", maxRedemptions: 100, redemptions: 88, active: true },
  { code: "FIRSTPC", type: CouponType.FLAT, value: 100000, label: "₹1,000 off one-time licenses above ₹7,000", minSubtotal: 700000, productIds: [], planTypes: [PlanType.ONE_TIME], starts: -50, ends: 40, maxRedemptions: 50, redemptions: 3, active: false },
];

/** Window length of MONSOON25 in the prototype (ago(120) to ago(36)), used when its fixed end is recent. */
const MONSOON_WINDOW_DAYS = 84;

/** Concrete coupon rows for a run at `now`. A fixed end date keeps the start at least one window before it. */
export function couponRules(now: Date): CouponRule[] {
  return COUPONS.map(({ starts, ends, ...rest }) => {
    const endsAt = typeof ends === "string" ? endOfDayIST(ends) : addDays(now, ends);
    let startsAt = addDays(now, starts);
    if (typeof ends === "string") {
      const latestStart = addDays(endsAt, -MONSOON_WINDOW_DAYS);
      if (startsAt.getTime() > latestStart.getTime()) startsAt = latestStart;
    }
    return { ...rest, startsAt, endsAt };
  });
}
