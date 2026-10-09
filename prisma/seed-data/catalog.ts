/**
 * SAMPLE catalog ported from design_handoff_axiomatic/prototype/axiomatic-data.js (CATEGORIES, PRODUCTS, PLANS).
 * Prices are paise EXCLUDING GST and, like versions and policies, are placeholders editable in Admin.
 * Copy is kept verbatim from the prototype (curly apostrophes, the multiplication sign, etc.).
 */
import { createHash } from "node:crypto";
import { BillingInterval, PlanType } from "@/generated/prisma/enums";
import type { ProductContent } from "@/lib/catalog/content";
import type { Tone } from "@/lib/design/tokens";

export type Platform = "windows" | "macos" | "android";
export const PLATFORMS: readonly Platform[] = ["windows", "macos", "android"];

// The schema lives in lib so storefront and admin code never import from prisma/.
export { productContentSchema, type ProductContent } from "@/lib/catalog/content";

/** `blurb` is the category card copy from Home.dc.html (the last three came with the coming-soon catalog). */
export type SeedCategory = { id: string; name: string; blurb: string; tone: Tone; icon: string };

/** Category.sortOrder is the position in this list. */
export const CATEGORIES: readonly SeedCategory[] = [
  { id: "pharmacy", name: "Medical & Pharmacy", blurb: "Billing with batch and expiry tracking for chemists and medical stores.", tone: "sage", icon: "local_pharmacy" },
  { id: "restaurant", name: "Restaurants & Cafés", blurb: "Table billing, KOTs and day-end reports for food businesses.", tone: "peach", icon: "room_service" },
  { id: "retail", name: "Retail & Grocery", blurb: "GST invoicing, barcode billing and stock for general stores.", tone: "blue", icon: "shopping_basket" },
  { id: "finance", name: "Finance & Office", blurb: "Cheque printing and payment records for any business.", tone: "lavender", icon: "account_balance" },
  // Added 2026-10-09 with the coming-soon catalog (prisma/seed-data/coming-soon.ts, additions.ts).
  { id: "jewellery", name: "Jewellery", blurb: "Billing with daily gold rates, HUID and tags for jewellers.", tone: "pink", icon: "workspace_premium" },
  { id: "wholesale", name: "Wholesale & Distribution", blurb: "Billing, schemes and collections for distributors, stockists and traders.", tone: "peach", icon: "warehouse" },
  { id: "industry", name: "Manufacturing & Logistics", blurb: "Software for factories, transporters and fuel stations.", tone: "blue", icon: "factory" },
];

/** Position of a category in CATEGORIES (Category.sortOrder). */
export function categorySortOrder(categoryId: string): number {
  const i = CATEGORIES.findIndex((c) => c.id === categoryId);
  if (i < 0) throw new RangeError(`Unknown category ${categoryId}`);
  return i;
}

export { COMING_SOON_PRODUCTS, COMING_SOON_PRODUCT_IDS, findComingSoonProduct, type SeedComingSoonProduct } from "./coming-soon";

export type SeedRelease = { version: string; /** IST calendar date */ date: string; size: string; notes: string[] };
/** `href`: optional "Read the guide" link (support FAQs), e.g. "/docs/activate". */
export type SeedFaq = { question: string; answer: string; href?: string };

export type SeedProduct = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  categoryId: string;
  tone: Tone;
  icon: string;
  rank: number;
  /** IST calendar date the product was added; becomes Product.createdAt. */
  added: string;
  tagline: string;
  summary: string;
  platforms: Platform[];
  demoEnabled: boolean;
  content: ProductContent;
  /** Newest first, as in the data file. */
  releases: SeedRelease[];
  faqs: SeedFaq[];
  relatedIds: string[];
};

type Triple = readonly [string, string, string];
type Pair = readonly [string, string];
const features = (rows: readonly Triple[]) => rows.map(([icon, title, body]) => ({ icon, title, body }));
const benefits = (rows: readonly Pair[]) => rows.map(([title, body]) => ({ title, body }));
const requirements = (rows: readonly Pair[]) => rows.map(([label, value]) => ({ label, value }));
const faqs = (rows: readonly Pair[]): SeedFaq[] => rows.map(([question, answer]) => ({ question, answer }));

export const PRODUCTS: readonly SeedProduct[] = [
  {
    id: "medical-billing",
    code: "MED",
    name: "Medical Store Billing Software",
    shortName: "Medical Store Billing",
    categoryId: "pharmacy",
    tone: "sage",
    icon: "medication",
    rank: 1,
    added: "2024-02-10",
    tagline: "Quick counter billing with batch, expiry and stock control for chemists.",
    summary:
      "Bill medicines by batch in seconds, keep a watch on expiry dates, manage purchases from distributors and print GST invoices on thermal, A5 or A4 printers.",
    platforms: ["windows"],
    demoEnabled: true,
    content: {
      features: features([
        ["inventory_2", "Batch & expiry tracking", "Pick the right batch at billing and get alerts for stock nearing expiry."],
        ["barcode_scanner", "Fast barcode billing", "Scan, or search by brand or salt name, and print in a few keystrokes."],
        ["local_shipping", "Purchases & distributors", "Record purchase bills, returns and outstanding payments per distributor."],
        ["receipt_long", "GST invoices", "CGST, SGST and IGST invoices with HSN codes on any common printer."],
        ["trending_down", "Reorder levels", "See low-stock items and create purchase orders from reorder levels."],
        ["clinical_notes", "Prescription register", "Record doctor and patient details for scheduled drugs when required."],
      ]),
      benefits: benefits([
        ["Shorter queues at the counter", "Keyboard-first billing designed for busy hours."],
        ["Less loss from expired stock", "Plan supplier returns before medicines expire."],
        ["Cleaner books for your CA", "Export sales, purchase and GST summaries."],
      ]),
      requirements: requirements([
        ["Operating system", "Windows 10 or 11 (64-bit)"],
        ["Processor", "Dual-core 2 GHz or faster"],
        ["Memory", "4 GB RAM (8 GB recommended)"],
        ["Storage", "2 GB free disk space"],
        ["Display", "1366 × 768 or higher"],
        ["Printers", "3-inch thermal, A5 or A4"],
        ["Internet", "Needed for activation and updates"],
      ]),
    },
    releases: [
      {
        version: "4.2.1",
        date: "2026-09-15",
        size: "148 MB",
        notes: ["Faster search by salt name", "Near-expiry return report", "Fixed thermal print cut-off on some 3-inch printers"],
      },
      { version: "4.2.0", date: "2026-07-02", size: "146 MB", notes: ["Distributor-wise outstanding report", "Bulk price update from purchase bill"] },
      { version: "4.1.3", date: "2026-03-20", size: "141 MB", notes: ["Stability fixes for large item lists"] },
    ],
    faqs: faqs([
      ["Can I import my existing medicine list?", "Yes. Import items from an Excel or CSV file during setup, including batch and expiry details."],
      ["Does it work without internet?", "Yes. Internet is needed only to activate the license and download updates."],
      [
        "What happens when an annual license ends?",
        "Your data stays on your computer. Creating new bills needs an active license, so renew before the end date to avoid interruption.",
      ],
    ]),
    relatedIds: ["general-store-gst", "cheque-printing"],
  },
  {
    id: "restaurant-billing",
    code: "RST",
    name: "Restaurant Billing Software",
    shortName: "Restaurant Billing",
    categoryId: "restaurant",
    tone: "peach",
    icon: "restaurant",
    rank: 2,
    added: "2024-08-22",
    tagline: "Table billing, KOT printing and menu management for restaurants and cafés.",
    summary:
      "Take orders by table or counter, send KOTs to the kitchen, split and merge bills, and close the day with clear sales reports.",
    platforms: ["windows", "android"],
    demoEnabled: true,
    content: {
      features: features([
        ["table_restaurant", "Table & counter billing", "See running tables at a glance and bill dine-in, takeaway or delivery orders."],
        ["print", "KOT printing", "Send kitchen order tickets to one or more kitchen printers."],
        ["call_split", "Split & merge bills", "Split by item or amount, merge tables, and record discount reasons."],
        ["menu_book", "Menu & modifiers", "Manage items, variants, add-ons and time-based prices."],
        ["percent", "GST & service charge", "Configure tax and service charge settings for your outlet."],
        ["bar_chart", "Day-end reports", "Item-wise sales, payment modes, cancellations and cash summary."],
      ]),
      benefits: benefits([
        ["Faster table turns", "Orders reach the kitchen as soon as they are taken."],
        ["Fewer billing mistakes", "Bills are built from the KOTs already sent."],
        ["Clear end-of-day picture", "Reconcile cash, UPI and card in minutes."],
      ]),
      requirements: requirements([
        ["Billing terminal", "Windows 10 or 11 (64-bit)"],
        ["Captain app", "Android 10 or later"],
        ["Memory", "4 GB RAM"],
        ["Storage", "1.5 GB free disk space"],
        ["Printers", "Thermal printers for bills and KOTs"],
        ["Network", "Local Wi-Fi for captain devices"],
      ]),
    },
    releases: [
      { version: "3.6.0", date: "2026-08-28", size: "122 MB", notes: ["Time-based menu pricing", "KOT reprint with reason"] },
      { version: "3.5.2", date: "2026-05-14", size: "119 MB", notes: ["Fixed table merge totals in rare cases"] },
    ],
    faqs: faqs([
      ["Is it billed per terminal?", "Yes. Each billing computer or captain device that is activated uses one terminal."],
      ["Can I cancel my subscription?", "Yes. It stays active until the end of the period you have paid for."],
      ["Does it work during internet outages?", "Billing and KOTs work on your local network without internet."],
    ]),
    relatedIds: ["general-store-gst", "cheque-printing"],
  },
  {
    id: "general-store-gst",
    code: "GST",
    name: "General Store GST Billing Software",
    shortName: "General Store GST Billing",
    categoryId: "retail",
    tone: "blue",
    icon: "storefront",
    rank: 3,
    added: "2023-11-05",
    tagline: "GST invoicing, barcode billing and stock for kirana and general stores.",
    summary:
      "Create B2B and B2C GST invoices, bill quickly with barcodes, track stock and customer credit, and share tax summaries with your accountant.",
    platforms: ["windows", "macos"],
    demoEnabled: true,
    content: {
      features: features([
        ["receipt_long", "B2B & B2C invoices", "Customer GSTIN, HSN codes and place of supply on every invoice."],
        ["barcode_scanner", "Barcode & quick billing", "Scan barcodes or use short codes for loose items sold by weight."],
        ["inventory", "Stock & purchases", "Track stock across items, units and suppliers."],
        ["account_balance_wallet", "Customer credit", "Track credit sales and send payment reminders."],
        ["summarize", "GST reports", "Sales, purchase and tax summaries ready for your accountant."],
        ["group", "Multi-user access", "Give staff their own logins with limited permissions."],
      ]),
      benefits: benefits([
        ["Professional invoices", "Consistent, GST-compliant formats for every customer."],
        ["Know your stock", "Fewer stock-outs and less dead stock."],
        ["Credit under control", "See who owes what at a glance."],
      ]),
      requirements: requirements([
        ["Operating system", "Windows 10/11 (64-bit) or macOS 13+"],
        ["Processor", "Dual-core 2 GHz or faster"],
        ["Memory", "4 GB RAM"],
        ["Storage", "2 GB free disk space"],
        ["Printers", "Thermal, A5 or A4"],
        ["Internet", "Needed for activation and updates"],
      ]),
    },
    releases: [
      { version: "5.0.2", date: "2026-09-30", size: "164 MB", notes: ["Customer credit reminders", "Faster startup on older computers"] },
      { version: "5.0.0", date: "2026-06-18", size: "160 MB", notes: ["New billing screen", "Multi-user permissions", "macOS support"] },
      { version: "4.8.1", date: "2026-01-22", size: "151 MB", notes: ["Invoice template fixes"] },
    ],
    faqs: faqs([
      ["Can my staff use separate logins?", "Yes, with the multi-user license. Each user has their own login and permissions."],
      [
        "Can I bill items sold by weight?",
        "Yes. Use short codes and enter weight at billing, or connect a supported weighing scale.",
      ],
      ["Can I move from another billing software?", "You can import items and customers from Excel or CSV."],
    ]),
    relatedIds: ["medical-billing", "cheque-printing"],
  },
  {
    id: "cheque-printing",
    code: "CHQ",
    name: "Cheque Printing Software",
    shortName: "Cheque Printing",
    categoryId: "finance",
    tone: "lavender",
    icon: "edit_document",
    rank: 4,
    added: "2023-06-14",
    tagline: "Print cheques on your bank's leaf with amount in words and a full register.",
    summary:
      "Set up your bank’s cheque layout once, print accurate cheques with the amount in words, and keep a searchable register of every cheque issued.",
    platforms: ["windows", "macos"],
    demoEnabled: true,
    content: {
      features: features([
        ["tune", "Adjustable cheque layouts", "Align fields once for your bank’s leaf and save the layout."],
        ["translate", "Amount in words", "Indian numbering with lakh and crore, generated automatically."],
        ["contacts", "Payee directory", "Save payees with default amounts and remarks."],
        ["manage_search", "Cheque register", "Search every cheque by payee, date, number or status."],
        ["event", "Post-dated reminders", "See post-dated cheques due this week."],
        ["border_color", "Crossing marks", "Print A/C payee and other crossing marks when needed."],
      ]),
      benefits: benefits([
        ["No spoiled leaves", "Preview and align before printing."],
        ["Fewer errors", "Amounts in words always match figures."],
        ["A clear paper trail", "Every cheque recorded with its status."],
      ]),
      requirements: requirements([
        ["Operating system", "Windows 10/11 or macOS 13+"],
        ["Memory", "2 GB RAM"],
        ["Storage", "500 MB free disk space"],
        ["Printer", "Any laser or inkjet printer"],
        ["Internet", "Needed for activation and updates"],
      ]),
    },
    releases: [
      { version: "3.1.0", date: "2026-08-05", size: "64 MB", notes: ["Bulk printing from Excel", "Layout copy between banks"] },
      { version: "3.0.0", date: "2026-04-11", size: "62 MB", notes: ["New layout designer", "macOS support"] },
    ],
    faqs: faqs([
      ["Which banks are supported?", "Any bank. You align the fields to your cheque leaf once and save it as a layout."],
      [
        "Is there a free trial?",
        "Not for this product. Request a demo and we will show it working with your cheque leaf.",
      ],
      ["Can I print on more than one computer?", "Choose the Office pack for up to three computers."],
    ]),
    relatedIds: ["general-store-gst", "medical-billing"],
  },
];

export type SeedPlan = {
  id: string;
  productId: string;
  type: PlanType;
  name: string;
  /** EXCLUDING GST. */
  pricePaise: number;
  interval: BillingInterval | null;
  trialDays: number | null;
  /** null for DEVICE_ADDON and MAINTENANCE: they change an existing license instead of granting slots. */
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
  popular: boolean;
  summary: string;
  includes: string[];
};

type PlanInput = Pick<SeedPlan, "id" | "productId" | "type" | "name" | "pricePaise" | "summary"> & Partial<SeedPlan>;

function plan(input: PlanInput): SeedPlan {
  return {
    interval: null,
    trialDays: null,
    deviceLimit: null,
    perUnit: null,
    maxQty: null,
    multiDevice: false,
    updatesMonths: null,
    popular: false,
    includes: [],
    ...input,
  };
}

const { TRIAL, ONE_TIME, ANNUAL, SUBSCRIPTION, DEVICE_ADDON, MAINTENANCE } = PlanType;
const { YEAR, MONTH } = BillingInterval;

/**
 * Data-file order; Plan.sortOrder is the position within its product. Subscription copy that implied automatic
 * charging ("Cancel any time") is reworded: v1 sells prepaid periods renewed from the account (decisions.md 2).
 */
export const PLANS: readonly SeedPlan[] = [
  plan({ id: "med-trial", productId: "medical-billing", type: TRIAL, name: "Free trial", pricePaise: 0, trialDays: 15, deviceLimit: 1, summary: "All features for 15 days on one computer.", includes: ["All features", "1 computer", "Email support"] }),
  plan({ id: "med-annual", productId: "medical-billing", type: ANNUAL, name: "Annual license", pricePaise: 499900, interval: YEAR, deviceLimit: 1, popular: true, summary: "Use on 1 computer for 12 months, with updates and support.", includes: ["1 computer", "All updates during the term", "Standard support", "Renews yearly"] }),
  plan({ id: "med-onetime", productId: "medical-billing", type: ONE_TIME, name: "One-time license", pricePaise: 1299900, deviceLimit: 1, updatesMonths: 12, summary: "Pay once and keep using the version you own.", includes: ["1 computer", "12 months of updates", "12 months standard support", "Optional yearly maintenance"] }),
  plan({ id: "med-device", productId: "medical-billing", type: DEVICE_ADDON, name: "Additional computer", pricePaise: 249900, summary: "Add one more computer to an existing license." }),
  plan({ id: "med-amc", productId: "medical-billing", type: MAINTENANCE, name: "Maintenance & support", pricePaise: 299900, interval: YEAR, summary: "Another year of updates and priority support for one-time licenses." }),
  plan({ id: "rst-trial", productId: "restaurant-billing", type: TRIAL, name: "Free trial", pricePaise: 0, trialDays: 7, deviceLimit: 1, summary: "All features for 7 days on one terminal.", includes: ["All features", "1 terminal", "Email support"] }),
  plan({ id: "rst-monthly", productId: "restaurant-billing", type: SUBSCRIPTION, name: "Monthly subscription", pricePaise: 69900, interval: MONTH, deviceLimit: 1, perUnit: "terminal", maxQty: 10, summary: "Billed every month per terminal. Renew from your account; nothing is charged automatically.", includes: ["Per terminal", "All updates", "Standard support", "No automatic charges"] }),
  plan({ id: "rst-yearly", productId: "restaurant-billing", type: SUBSCRIPTION, name: "Yearly subscription", pricePaise: 699900, interval: YEAR, deviceLimit: 1, perUnit: "terminal", maxQty: 10, popular: true, summary: "Billed yearly per terminal.", includes: ["Per terminal", "All updates", "Priority support", "Lower yearly cost"] }),
  plan({ id: "gst-trial", productId: "general-store-gst", type: TRIAL, name: "Free trial", pricePaise: 0, trialDays: 15, deviceLimit: 1, summary: "All features for 15 days on one computer.", includes: ["All features", "1 computer", "Email support"] }),
  plan({ id: "gst-annual", productId: "general-store-gst", type: ANNUAL, name: "Annual license", pricePaise: 349900, interval: YEAR, deviceLimit: 1, summary: "1 computer for 12 months with updates.", includes: ["1 computer", "All updates during the term", "Standard support"] }),
  plan({ id: "gst-onetime", productId: "general-store-gst", type: ONE_TIME, name: "One-time license", pricePaise: 799900, deviceLimit: 1, updatesMonths: 12, popular: true, summary: "Pay once for one computer.", includes: ["1 computer", "12 months of updates", "12 months standard support"] }),
  plan({ id: "gst-multi", productId: "general-store-gst", type: ONE_TIME, multiDevice: true, name: "Multi-user license", pricePaise: 1999900, deviceLimit: 5, updatesMonths: 12, summary: "Up to 5 computers with separate staff logins.", includes: ["Up to 5 computers", "Staff logins & permissions", "12 months of updates", "Priority support"] }),
  plan({ id: "gst-amc", productId: "general-store-gst", type: MAINTENANCE, name: "Maintenance & support", pricePaise: 199900, interval: YEAR, summary: "Another year of updates for one-time licenses." }),
  plan({ id: "chq-onetime", productId: "cheque-printing", type: ONE_TIME, name: "Single computer", pricePaise: 299900, deviceLimit: 1, updatesMonths: 12, summary: "One computer, pay once.", includes: ["1 computer", "12 months of updates", "Standard support"] }),
  plan({ id: "chq-office", productId: "cheque-printing", type: ONE_TIME, multiDevice: true, name: "Office pack", pricePaise: 699900, deviceLimit: 3, updatesMonths: 12, popular: true, summary: "Up to 3 computers, pay once.", includes: ["Up to 3 computers", "12 months of updates", "Standard support"] }),
  plan({ id: "chq-amc", productId: "cheque-printing", type: MAINTENANCE, name: "Annual maintenance", pricePaise: 99900, interval: YEAR, summary: "Another year of updates and support." }),
];

/** Position of a plan within its product, in data-file order (Plan.sortOrder). */
export function planSortOrder(planId: string): number {
  const target = PLANS.find((p) => p.id === planId);
  if (!target) throw new RangeError(`Unknown plan ${planId}`);
  return PLANS.filter((p) => p.productId === target.productId).findIndex((p) => p.id === planId);
}

export function findPlan(planId: string): SeedPlan {
  const found = PLANS.find((p) => p.id === planId);
  if (!found) throw new RangeError(`Unknown plan ${planId}`);
  return found;
}

export function findProduct(productId: string): SeedProduct {
  const found = PRODUCTS.find((p) => p.id === productId);
  if (!found) throw new RangeError(`Unknown product ${productId}`);
  return found;
}

const BYTES_PER_MB = 1024 * 1024;

/** "148 MB" -> 148 MiB in bytes (the data file gives one size per release; every platform file reuses it). */
export function parseSizeBytes(size: string): bigint {
  const m = /^(\d+(?:\.\d+)?) MB$/.exec(size);
  if (!m) throw new RangeError(`Unrecognised size "${size}"`);
  return BigInt(Math.round(Number(m[1]) * BYTES_PER_MB));
}

const FILE_SUFFIX: Record<Platform, string> = { windows: "-setup.exe", macos: ".dmg", android: ".apk" };

/** "MedicalStoreBilling-4.2.1-setup.exe": the short name without spaces or punctuation. */
export function releaseFileName(product: Pick<SeedProduct, "shortName">, version: string, platform: Platform): string {
  const base = product.shortName.replace(/[^A-Za-z0-9]+/g, "");
  return `${base}-${version}${FILE_SUFFIX[platform]}`;
}

export function releaseStorageKey(productId: string, version: string, fileName: string): string {
  return `releases/${productId}/${version}/${fileName}`;
}

/** No installer exists for sample releases, so the checksum is that of a marker text naming the object. */
export function sampleSha256(storageKey: string): string {
  return createHash("sha256").update(`SAMPLE ${storageKey}`, "utf8").digest("hex");
}
