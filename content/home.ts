/**
 * Home page copy, verbatim from design_handoff_axiomatic/prototype/Home.dc.html. Typed constants, so marketing text
 * can be edited here without touching the layout in components/store/home/*.
 *
 * Data-driven parts come from lib/storefront/data.ts: products, categories, FAQs (Faq page "home"), the release
 * announcement and the business hours. The helpers at the end turn that data into the copy the page shows.
 * Overlines are written in sentence case; SectionHeading uppercases them with CSS.
 */
import type { IconName } from "@/components/icons/registry";
import type { Tone } from "@/lib/design/tokens";
import { demoHref, hasTrial, majorMinor, productHref } from "@/lib/storefront/derive";
import type { StoreLatestRelease, StorePlan, StoreProduct } from "@/lib/storefront/types";

export const HOME_META = {
  title: "Axiomatic Software Solutions — Smart software for everyday business",
  description:
    "Licensed billing, GST invoicing and cheque printing software for Indian businesses. Buy, download and activate in minutes.",
} as const;

/** Shared call-to-action labels (hero and final CTA). */
export const HOME_CTAS = {
  explore: "Explore Software",
  demo: "Request a Demo",
} as const;

export const HOME_HERO = {
  badge: "New",
  title: "Smart software for everyday business.",
  body: "Billing, GST invoicing and cheque printing software for medical stores, restaurants and retail shops. Choose a license that suits you, install it on your own computers and activate it with a key — your data stays with you.",
  bullets: ["Free trials on selected products", "GST invoice with every purchase", "Works offline after activation"],
} as const;

export type IllustrationRow = { item: string; hsn: string; qty: number; amount: string };

/** The decorative UI composite next to the hero text (sample figures, not live data). */
export const HERO_ILLUSTRATION = {
  description: "Illustrative preview of General Store GST Billing and Cheque Printing software",
  window: {
    title: "General Store GST Billing — Counter 1",
    status: "Licensed",
    nav: ["Billing", "Items", "Purchases", "Customers", "GST reports"],
    invoice: "Tax invoice INV/1182",
    invoiceType: "B2B · Intra-state",
    search: "Scan barcode or search item…",
    columns: { item: "Item", hsn: "HSN", qty: "Qty", amount: "Amount" },
    rows: [
      { item: "Basmati rice 5 kg", hsn: "1006", qty: 2, amount: "₹1,040.00" },
      { item: "Sunflower oil 1 L", hsn: "1512", qty: 3, amount: "₹435.00" },
      { item: "Toor dal 1 kg", hsn: "0713", qty: 2, amount: "₹318.00" },
      { item: "Detergent powder 1 kg", hsn: "3402", qty: 1, amount: "₹210.00" },
    ] satisfies readonly IllustrationRow[],
    totals: [
      { label: "Taxable value", amount: "₹1,861.90" },
      { label: "CGST + SGST", amount: "₹141.10" },
    ],
    total: { label: "Total", amount: "₹2,003.00" },
    actions: { secondary: "Hold", primary: "Save & print" },
  },
  cheque: {
    title: "Cheque Printing",
    date: "06 10 2026",
    payLabel: "Pay",
    payee: "Shree Distributors",
    wordsLabel: "Rupees",
    words: "Twenty-four thousand five hundred only",
    amount: "₹24,500.00",
  },
  license: { title: "License active", detail: "2 of 3 computers · renews 16 Nov" },
} as const;

export const HOME_FEATURED = {
  overline: "Our software",
  title: "Built for the way your shop runs",
  from: "From",
  viewDetails: "View details",
  freeTrial: "Free trial",
  requestDemo: "Request demo",
} as const;

export const HOME_CATEGORIES = {
  overline: "Browse by business",
  title: "Find software for your type of business",
  more: {
    title: "More on the way",
    body: "Tell us what your business needs and we'll let you know when it's ready.",
    link: "Suggest a category",
    href: "/contact",
  },
} as const;

export type HomeBenefit = { icon: IconName; tone: Tone; title: string; body: string };

export const HOME_WHY = {
  overline: "Why Axiomatic",
  title: "Straightforward software you can rely on every day",
  lead: "We build focused tools for specific businesses, sell them with clear licenses, and keep improving them with regular updates.",
  benefits: [
    {
      icon: "wifi_off",
      tone: "blue",
      title: "Runs on your computer",
      body: "Bill even when the internet is down. Internet is needed only to activate and update.",
    },
    {
      icon: "receipt_long",
      tone: "sage",
      title: "GST-ready invoices",
      body: "CGST, SGST and IGST, HSN codes and customer GSTIN on every invoice.",
    },
    {
      icon: "key",
      tone: "lavender",
      title: "Licenses you can see",
      body: "Your account shows each key, its expiry and the computers using it.",
    },
    {
      icon: "update",
      tone: "peach",
      title: "Regular updates",
      body: "Improvements and tax format changes delivered through your account.",
    },
    {
      icon: "support_agent",
      tone: "pink",
      title: "Support in Indian hours",
      body: "Tickets, email and phone help during business hours.",
    },
    {
      icon: "database",
      tone: "sage",
      title: "Your data stays yours",
      body: "Data is stored on your computer, with built-in backup and export.",
    },
  ] satisfies readonly HomeBenefit[],
} as const;

export type HomeStep = { icon: IconName; tone: Tone; title: string; body: string };

export const HOME_HOW = {
  overline: "How it works",
  title: "Purchase, download, activate",
  stepLabel: "Step",
  steps: [
    {
      icon: "shopping_cart_checkout",
      tone: "lavender",
      title: "Choose a plan and pay",
      body: "Pick a license, enter your business details with optional GSTIN, and pay by UPI, card or net banking.",
    },
    {
      icon: "download",
      tone: "blue",
      title: "Download the installer",
      body: "Get the latest version you are eligible for from your account, using a secure link.",
    },
    {
      icon: "key",
      tone: "sage",
      title: "Activate with your key",
      body: "Enter the license key in the software. You can see and manage activated computers anytime.",
    },
  ] satisfies readonly HomeStep[],
  note: "Licenses are issued only after our server confirms your payment with the payment provider.",
} as const;

export const HOME_SUPPORT = {
  overline: "Support",
  title: "Help from people who know the software",
  body: "Every paid license includes standard support during its term. Reach us by ticket, email or phone.",
  tickets: "Support tickets from your account",
  /** Shown after the business hours while the business details are placeholders (settings business.sample). */
  configurable: "(configurable)",
  guides: "Step-by-step installation guides",
  link: "Visit the support center",
  href: "/support",
} as const;

export const HOME_MAINTENANCE = {
  overline: "Maintenance plans",
  title: "Keep one-time licenses up to date",
  items: ["New versions and GST format updates", "Priority ticket and phone support", "Help moving to a new computer"],
  link: "How licensing works",
  href: "/pricing#maintenance",
} as const;

export const HOME_FAQ = {
  overline: "FAQ",
  title: "Questions business owners ask us",
} as const;

export const HOME_FINAL_CTA = {
  title: "Try it at your own counter.",
  body: "Start a free trial where available, or ask us for a guided demo on a call.",
} as const;

// ---------- Copy derived from data ----------

/** Updates included with a one-time license when no plan says otherwise (Plan.updatesMonths default). */
export const DEFAULT_UPDATES_MONTHS = 12;

/** Hero pill: "General Store GST Billing 5.0 is out". */
export function announcementText(latest: StoreLatestRelease): string {
  return `${latest.product.shortName} ${majorMinor(latest.release.version)} is out`;
}

/** Hero pill target: the product's release notes. */
export function announcementHref(latest: StoreLatestRelease): string {
  return `${productHref(latest.product.id)}#releases`;
}

/** Category tile count: "1 product", "2 products". */
export function categoryCountLabel(count: number): string {
  return `${count} ${count === 1 ? "product" : "products"}`;
}

/** Price note after the "From" price, for each price display mode: "/year + GST" or "/year incl. GST". */
export function priceNote(unit: string): { excl: string; incl: string } {
  return { excl: `${unit} + GST`, incl: `${unit} incl. GST` };
}

/** Maintenance card paragraph, with the months of updates one-time licenses include. */
export function maintenanceBody(months: number): string {
  return `One-time licenses include ${months} months of updates. After that, the software keeps working on the version you have. Add a yearly maintenance plan to continue getting:`;
}

/** Months of updates in the first one-time plan that sets them (catalog order), else the default of 12. */
export function oneTimeUpdatesMonths(products: readonly Pick<StoreProduct, "plans">[]): number {
  for (const product of products) {
    const plan = product.plans.find(
      (p: StorePlan) => p.type === "ONE_TIME" && p.updatesMonths !== null && p.updatesMonths > 0,
    );
    if (plan?.updatesMonths) return plan.updatesMonths;
  }
  return DEFAULT_UPDATES_MONTHS;
}

export type ProductSecondaryCta = { kind: "trial" | "demo"; label: string; href: string };

/**
 * The product card's second button: "Free trial" (the product page's plans) when the product has a trial,
 * otherwise "Request demo" (contact form, product preselected) when demos are enabled, otherwise none.
 */
export function productSecondaryCta(
  product: Pick<StoreProduct, "id" | "plans" | "demoEnabled">,
): ProductSecondaryCta | null {
  if (hasTrial(product)) {
    return { kind: "trial", label: HOME_FEATURED.freeTrial, href: `${productHref(product.id)}#plans` };
  }
  if (product.demoEnabled) return { kind: "demo", label: HOME_FEATURED.requestDemo, href: demoHref(product.id) };
  return null;
}
