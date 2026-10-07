/**
 * Pricing & licensing page copy (/pricing), verbatim from design_handoff_axiomatic/prototype/Pricing.dc.html.
 * Numbers that come from settings or plans (GST rate, update months, maintenance cover) are function arguments,
 * never literals. Deliberate changes (docs/decisions.md): subscriptions are renewed manually (decision 2).
 * The payments and refunds card is not in the prototype; its copy comes from the Home FAQ and the Payment page.
 */
import type { IconName } from "@/components/icons/registry";
import type { Tone } from "@/lib/design/tokens";

export const PRICING_PAGE = {
  path: "/pricing",
  /** Document title; the root template adds " — Axiomatic Software Solutions". */
  title: "Pricing & licensing",
  description:
    "How Axiomatic licenses work: trials, one-time, annual, subscription, multi-device and maintenance plans. Prices in INR with GST shown clearly.",
  breadcrumbHome: "Home",
  breadcrumb: "Pricing & licensing",
  heading: "Clear prices. Licenses you can understand.",
  lead: "Each product offers the license types that suit how it’s used. Every price is in rupees, and we always show whether GST is included.",
} as const;

export const PRICING_MATRIX = {
  caption: "Which licenses each product offers",
  captionExcl: "· starting prices excluding GST",
  captionIncl: (ratePct: string) => `· starting prices including ${ratePct}% GST`,
  productColumn: "Product",
  columns: {
    trial: "Trial",
    one_time: "One-time",
    annual: "Annual",
    subscription: "Subscription",
    multi: "Multi-device",
    maintenance: "Maintenance",
  },
  free: "Free",
  notOffered: "Not offered",
  upToDevices: (count: number) => `up to ${count} devices`,
  /** Shown only while the sample notice is on: the prices are sample data until the owner sets real ones. */
  sampleNote: "Sample prices for this prototype — configurable per product in Admin → Plans.",
  dashNote: "A dash means that license type isn’t offered for the product.",
} as const;

export type LicenseTypeCardKey = "trial" | "one_time" | "annual" | "subscription" | "multi" | "maintenance";

export type LicenseTypeCopy = {
  key: LicenseTypeCardKey;
  icon: IconName;
  tone: Tone;
  name: string;
  what: string;
  updates: string;
  ends: string;
  bestFor: string;
};

export type LicenseTypeValues = {
  /** One-time update period, e.g. "12 months" (from the ONE_TIME plans). */
  oneTimeUpdates: string;
  /** Maintenance cover, e.g. "12 months" (MAINTENANCE_MONTHS_PER_UNIT in lib/licensing/terms.ts). */
  maintenanceCover: string;
  /** "a year" for 12 months, otherwise e.g. "6 months". */
  maintenanceSpan: string;
};

/** One-time update period as the copy states it: "12 months", or "at least 12 months" when plans differ. */
export function updatePeriodLabel(period: string, varies: boolean): string {
  return varies ? `at least ${period}` : period;
}

export const LICENSE_TYPES_COPY = {
  heading: "License types, in plain words",
  terms: { updates: "Updates", ends: "When it ends", bestFor: "Best for" },
} as const;

/** The six "License types, in plain words" cards, in prototype order. */
export function licenseTypeCards(v: LicenseTypeValues): LicenseTypeCopy[] {
  return [
    {
      key: "trial",
      icon: "timer",
      tone: "blue",
      name: "Free trial",
      what: "Use every feature for a limited number of days on one computer. No payment needed.",
      updates: "Latest version",
      ends: "The software stops creating new bills. Buy a license to continue with the same data.",
      bestFor: "Checking fit before you buy",
    },
    {
      key: "one_time",
      icon: "all_inclusive",
      tone: "lavender",
      name: "One-time license",
      what: "Pay once and keep using the version you own, for as long as you like.",
      updates: `${v.oneTimeUpdates} included, then optional maintenance`,
      ends: "Nothing stops. You keep working on your current version.",
      bestFor: "Shops that prefer a single payment",
    },
    {
      key: "annual",
      icon: "event_repeat",
      tone: "sage",
      name: "Annual license",
      what: "Pay every year. Updates and support are included while it’s active.",
      updates: "Always included",
      ends: "New bills pause until you renew. Your data stays on your computer.",
      bestFor: "Lower upfront cost with updates built in",
    },
    {
      key: "subscription",
      icon: "autorenew",
      tone: "peach",
      name: "Subscription",
      // Decision 2: prepaid periods renewed by hand. The prototype's "Cancel any time" implied an automatic charge.
      what: "Monthly or yearly, per billing terminal. Renew each period from your account; nothing is charged automatically.",
      updates: "Always included",
      ends: "Access continues to the end of the paid period. New bills pause until you renew.",
      bestFor: "Restaurants that add or remove terminals",
    },
    {
      key: "multi",
      icon: "devices",
      tone: "pink",
      name: "Multi-device",
      what: "One license that covers several computers or users, with its own device limit.",
      updates: "Same as the license type",
      ends: "Same as the license type",
      bestFor: "Businesses with more than one counter",
    },
    {
      key: "maintenance",
      icon: "build_circle",
      tone: "lavender",
      name: "Maintenance plan",
      what: `An add-on for one-time licenses that restarts updates and priority support for ${v.maintenanceSpan}.`,
      updates: `${v.maintenanceCover} from purchase`,
      ends: "You keep the last version released during your cover.",
      bestFor: "One-time owners who want new versions",
    },
  ];
}

export type MaintenanceValues = {
  /** "12 months", or "at least 12 months" when the one-time plans differ. */
  oneTimeUpdates: string;
  /** "yearly" for 12 months, otherwise e.g. "6-month". */
  maintenanceAdjective: string;
};

export const MAINTENANCE_COPY = {
  heading: "Maintenance & support plans",
  body: (v: MaintenanceValues) =>
    `One-time licenses include ${v.oneTimeUpdates} of updates and support. After that, the software keeps working on the version you have. A ${v.maintenanceAdjective} maintenance plan restarts updates and priority support from the day you renew, or from the day your current cover ends if you renew early.`,
  bullets: ["New versions and tax format changes", "Priority tickets and phone support", "Help moving to a new computer"],
} as const;

export const GST_COPY = {
  heading: "How GST is charged",
  body: (ratePct: string, halfPct: string) =>
    `Software licenses attract ${ratePct}% GST. If your billing address is in the same state as ours, the invoice shows CGST ${halfPct}% + SGST ${halfPct}%. Otherwise it shows IGST ${ratePct}%. Add your GSTIN at checkout to claim input tax credit.`,
  exampleLabel: (planName: string) => `Example: ${planName}`,
  gstLabel: (ratePct: string) => `GST ${ratePct}%`,
  totalLabel: "You pay",
  note: "Tax rules are configurable. Confirm rates and codes with your tax adviser.",
} as const;

export type PaymentMethodCopy = { icon: IconName; label: string; detail: string };

export const PAYMENT_COPY = {
  heading: "Ways to pay",
  methods: [
    { icon: "qr_code_2", label: "UPI", detail: "Any UPI app" },
    { icon: "credit_card", label: "Card", detail: "Debit or credit card" },
    { icon: "account_balance", label: "Net banking", detail: "All major banks" },
  ] as const satisfies readonly PaymentMethodCopy[],
  body: "UPI, debit and credit cards, and net banking through our payment partner. Your license is issued as soon as the payment is confirmed.",
  refundHeading: "Refunds",
  refundBody:
    "Refund eligibility depends on the product and license type. Please read our refund policy before purchasing, or start with a free trial where one is available.",
  refundLink: { label: "Read the refund policy", href: "/legal/refund" },
} as const;

export const PRICING_FAQ_COPY = {
  heading: "Licensing questions",
  /** Link after an answer when its FAQ row has an href. */
  more: "Read more",
} as const;

export const PRICING_CTA = {
  heading: "Not sure which license fits?",
  body: "Tell us how many counters and computers you have. We’ll suggest the right plan.",
  compare: "Compare products",
  talk: "Talk to us",
} as const;
