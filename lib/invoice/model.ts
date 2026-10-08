/**
 * Tax invoice view model shared by the order page (HTML summary + print stylesheet) and the PDF
 * (lib/invoice/pdf.tsx). Pure and client-safe: no database, no Node APIs.
 *
 * Inputs are the order snapshot (billing, totals, line amounts written at checkout) plus the invoice's seller snapshot
 * and SAC; nothing is re-priced. Line CGST/SGST shares are allocated from the order header by largest remainder, so
 * lines always sum to the header (docs/decisions.md 3). Dates display in IST; amounts are exact to the paisa.
 *
 * The same model renders the credit note of a billing correction (document.kind "credit_note"; Admin > Orders "Correct
 * billing", docs/decisions.md "Admin records"): it cancels the original invoice in full, so its lines and totals are the
 * invoice's, with its own number, date, "AGAINST INVOICE" reference and notes. A corrected invoice carries a
 * "This invoice replaces …" note.
 */
import { DEFAULT_GST_RATE_PCT, formatINR } from "@/lib/money";
import { formatDateIST, istParts, MONTHS_SHORT } from "@/lib/dates";
import { gstCodeForState } from "@/lib/validation/states";

/** Brand name printed as the seller while the business details are placeholders (decisions.md 14). */
export const SELLER_BRAND_NAME = "Axiomatic Software Solutions";
/** Order statuses that carry a tax invoice (the invoice is allocated when the payment is captured). */
export const INVOICE_STATUSES: ReadonlySet<string> = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);
export const UNREGISTERED_BUYER = "Unregistered (no GSTIN)";
const MINUS = "−";

export type InvoiceSeller = {
  legalName: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  pin: string;
  /** True while the seller details are placeholders. */
  sample: boolean;
};

export type InvoiceBilling = {
  name: string;
  email: string;
  phone: string;
  business: string | null;
  address: string;
  city: string;
  state: string;
  pin: string;
  gstin: string | null;
};

export type InvoiceItemKind = "NEW" | "RENEWAL" | "UPGRADE" | "ADDON";

export type InvoiceLineInput = {
  productName: string;
  /** Short product name for the compact summary rows ("Medical Store Billing"); falls back to productName. */
  productShortName?: string | null;
  planName: string;
  kind: InvoiceItemKind;
  qty: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
};

export type InvoiceTotalsInput = {
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
};

export type InvoiceModelInput = {
  orderId: string;
  /** OrderStatus value ("PAID", "CONFIRMING", ...). */
  status: string;
  createdAt: string | Date;
  invoice: { number: string; issuedAt: string | Date } | null;
  sac: string;
  seller: InvoiceSeller;
  billing: InvoiceBilling;
  placeOfSupply: string;
  couponCode: string | null;
  totals: InvoiceTotalsInput;
  items: readonly InvoiceLineInput[];
  /** Used only when the rate cannot be read from the totals (e.g. a zero taxable value). */
  fallbackGstRatePct?: number;
  /**
   * Which document this is (default a tax invoice). For a credit note, `invoice` holds the credit note's own number and
   * date, and `against` the invoice it cancels.
   */
  document?: InvoiceDocumentInput;
};

export type InvoiceDocumentInput =
  | { kind: "invoice"; replaces?: { invoiceNo: string; creditNoteNo: string } | null }
  | { kind: "credit_note"; against: { number: string; issuedAt: string | Date }; replacedBy: string | null };

export type InvoiceDocumentKind = "invoice" | "credit_note";

export type InvoiceLine = {
  /** 1-based row number. */
  index: number;
  productName: string;
  shortName: string;
  planName: string;
  kind: InvoiceItemKind;
  /** "Renewal of LIC-24017", "Upgrade of …", "Add-on for …"; null for new licenses. */
  kindNote: string | null;
  /** Summary row detail: "Annual license", "Per-terminal license × 3", "Annual license · Renewal of LIC-24017". */
  detail: string;
  qty: number;
  unitPricePaise: number;
  /** unit price × qty, before discount. */
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  /** Taxable value + tax. */
  amountPaise: number;
};

export type InvoiceTotalRow = {
  key: "subtotal" | "discount" | "taxable" | "cgst" | "sgst" | "igst" | "total";
  label: string;
  paise: number;
  /** Formatted with the rupee sign, exact to the paisa; the discount carries a minus sign. */
  display: string;
  strong: boolean;
};

export type InvoiceParty = {
  name: string;
  lines: string[];
  gstinLine: string;
};

export type InvoiceModel = {
  orderId: string;
  status: string;
  /** "invoice" (tax invoice or order summary) or "credit_note". */
  kind: InvoiceDocumentKind;
  /** "Tax invoice" or "Credit note" (PDF title). */
  docLabel: string;
  /** "INVOICE NO." or "CREDIT NOTE NO." */
  numberLabel: string;
  /** "INVOICE DATE" or "DATE" */
  dateLabel: string;
  /** Credit notes: the invoice they cancel ("AXS/26-27/0012 · 7 Oct 2026"). */
  reference: { label: "AGAINST INVOICE"; value: string } | null;
  /** Extra lines for the notes (why a credit note was issued, which invoice a corrected one replaces). */
  extraNotes: string[];
  /** True when the order has a tax invoice to show, print and download. */
  isInvoice: boolean;
  /** "Tax invoice AXS/26-27/1181" or "Order summary". */
  title: string;
  number: string | null;
  /** Invoice date ("7 Oct 2026"), or null without an invoice. */
  invoiceDate: string | null;
  /** Order date and time as the order page shows it ("7 Oct 2026, 4:02 pm"). */
  orderDateTime: string;
  orderDate: string;
  seller: InvoiceParty & {
    /** "Pune, Maharashtra" (the order page's compact SOLD BY block). */
    location: string;
    stateCode: string | null;
    sample: boolean;
  };
  buyer: InvoiceParty & {
    /** The person's name when a business name is billed. */
    attention: string | null;
    /** "address, city, state, pin" on one line (order page). */
    addressLine: string;
    email: string;
    phone: string;
    stateCode: string | null;
  };
  sac: string;
  placeOfSupply: string;
  /** "Maharashtra (27)". */
  placeOfSupplyLabel: string;
  supply: "intra" | "inter";
  gstRatePct: number;
  /** "18%" and the half rate for CGST/SGST ("9%"). */
  rateLabel: string;
  halfRateLabel: string;
  couponCode: string | null;
  lines: InvoiceLine[];
  totals: InvoiceTotalRow[];
  totalPaise: number;
  totalLabel: string;
  amountInWords: string;
};

// ---------- Amount in words (Indian numbering) ----------

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
] as const;
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"] as const;

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const tens = TENS[Math.floor(n / 10)] ?? "";
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones] ?? ""}`;
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ""} Hundred`);
  if (rest > 0) parts.push(below100(rest));
  return parts.join(" ");
}

/**
 * A whole number in words with Indian grouping: 1,23,45,678 -> "One Crore Twenty-Three Lakh Forty-Five Thousand
 * Six Hundred Seventy-Eight". Amounts of 100 crore and more repeat the scale ("One Hundred Crore").
 */
export function indianNumberWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Expected a non-negative integer, got ${n}`);
  if (n === 0) return ONES[0];
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore > 0) parts.push(`${indianNumberWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh > 0) parts.push(`${below100(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand > 0) parts.push(`${below100(thousand)} Thousand`);
  if (rest > 0) parts.push(below1000(rest));
  return parts.join(" ");
}

/** "Rupees Five Thousand Three Hundred Eight and Ninety-Four paise only" (or "Rupees Four Thousand only"). */
export function amountInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError(`Expected a non-negative amount in paise, got ${paise}`);
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const head = `Rupees ${indianNumberWords(rupees)}`;
  return rest > 0 ? `${head} and ${indianNumberWords(rest)} paise only` : `${head} only`;
}

// ---------- Helpers ----------

/** The GST rate the totals were computed with: the slab whose rounding reproduces the tax, else the ratio. */
export function inferGstRatePct(taxablePaise: number, taxPaise: number, fallback: number = DEFAULT_GST_RATE_PCT): number {
  if (!(taxablePaise > 0)) return fallback;
  const slabs = [fallback, 18, 12, 5, 28, 40, 3, 0.25, 0];
  for (const rate of slabs) {
    if (Math.round((taxablePaise * rate) / 100) === taxPaise) return rate;
  }
  return Math.round((taxPaise / taxablePaise) * 10_000) / 100;
}

/** "18%", "9%", "0.25%", "1.5%". */
export function percentLabel(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}%`;
}

/**
 * Splits `total` across `weights` in proportion, by largest remainder (ties go to the earlier line), so the parts
 * always add up to `total`. BigInt keeps the products exact for any paise amount.
 */
export function allocateByWeight(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const product = bigTotal * BigInt(Math.max(0, w));
    return { index, base: product / bigSum, remainder: product % bigSum };
  });
  let left = total - parts.reduce((acc, p) => acc + Number(p.base), 0);
  const order = [...parts].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const out = parts.map((p) => Number(p.base));
  for (const p of order) {
    if (left <= 0) break;
    out[p.index] = (out[p.index] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "7 Oct 2026, 4:02 pm" in IST (the prototype's en-IN order date). */
export function formatOrderDateTime(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const p = istParts(d);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${p.day} ${MONTHS_SHORT[p.month - 1] ?? ""} ${p.year}, ${hour12}:${pad2(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;
}

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

function money(paise: number): string {
  return formatINR(paise, { exact: true });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads an Invoice.seller JSON snapshot leniently (missing fields become empty strings). */
export function readSellerSnapshot(json: unknown): InvoiceSeller {
  const v = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  return {
    legalName: str(v.legalName),
    gstin: str(v.gstin),
    address: str(v.address),
    city: str(v.city),
    state: str(v.state),
    pin: str(v.pin),
    sample: v.sample === true,
  };
}

const joinParts = (parts: readonly string[], sep = ", ") => parts.map((p) => p.trim()).filter((p) => p !== "").join(sep);

/** "Renewal of LIC-24017" etc. (cart line prefixes), or null for a new license. */
export function itemKindNote(kind: InvoiceItemKind, targetLicenseId: string | null): string | null {
  if (kind === "NEW" || !targetLicenseId) return null;
  if (kind === "RENEWAL") return `Renewal of ${targetLicenseId}`;
  if (kind === "UPGRADE") return `Upgrade of ${targetLicenseId}`;
  return `Add-on for ${targetLicenseId}`;
}

// ---------- The model ----------

function sellerParty(seller: InvoiceSeller): InvoiceModel["seller"] {
  const location = joinParts([seller.city, seller.state]);
  const cityLine = joinParts([joinParts([seller.city, seller.state]), seller.pin], " ");
  return {
    name: seller.sample || seller.legalName === "" ? SELLER_BRAND_NAME : seller.legalName,
    lines: [seller.address, cityLine].filter((l) => l.trim() !== ""),
    gstinLine: seller.gstin ? `GSTIN ${seller.gstin}${seller.sample ? " (sample)" : ""}` : "GSTIN not set",
    location,
    stateCode: seller.state ? gstCodeForState(seller.state) : null,
    sample: seller.sample,
  };
}

function buyerParty(billing: InvoiceBilling): InvoiceModel["buyer"] {
  const business = billing.business?.trim() || null;
  const cityLine = joinParts([joinParts([billing.city, billing.state]), billing.pin], " ");
  return {
    name: business ?? billing.name,
    attention: business ? billing.name : null,
    lines: [billing.address, cityLine].filter((l) => l.trim() !== ""),
    addressLine: joinParts([billing.address, billing.city, billing.state, billing.pin]),
    gstinLine: billing.gstin ? `GSTIN ${billing.gstin}` : UNREGISTERED_BUYER,
    email: billing.email,
    phone: billing.phone,
    stateCode: billing.state ? gstCodeForState(billing.state) : null,
  };
}

/** Builds the invoice (or, before payment, the order summary) view of an order. */
export function buildInvoiceModel(input: InvoiceModelInput): InvoiceModel {
  const { totals } = input;
  const supply: InvoiceModel["supply"] = totals.igstPaise > 0 ? "inter" : "intra";
  const taxPaise = totals.cgstPaise + totals.sgstPaise + totals.igstPaise;
  const gstRatePct = inferGstRatePct(totals.taxablePaise, taxPaise, input.fallbackGstRatePct ?? DEFAULT_GST_RATE_PCT);
  const isInvoice = input.invoice !== null && INVOICE_STATUSES.has(input.status);

  const lineTax = input.items.map((i) => i.taxPaise);
  const linesMatchHeader = lineTax.reduce((a, b) => a + b, 0) === taxPaise;
  const cgstShares =
    supply === "intra"
      ? linesMatchHeader
        ? allocateByWeight(totals.cgstPaise, lineTax)
        : lineTax.map((t) => Math.round(t / 2))
      : lineTax.map(() => 0);

  const lines: InvoiceLine[] = input.items.map((item, i) => {
    const kindNote = itemKindNote(item.kind, item.targetLicenseId);
    const qtyPart = item.qty > 1 ? ` × ${item.qty}` : "";
    const cgst = cgstShares[i] ?? 0;
    return {
      index: i + 1,
      productName: item.productName,
      shortName: item.productShortName?.trim() || item.productName,
      planName: item.planName,
      kind: item.kind,
      kindNote,
      detail: `${item.planName}${qtyPart}${kindNote ? ` · ${kindNote}` : ""}`,
      qty: item.qty,
      unitPricePaise: item.unitPricePaise,
      grossPaise: item.unitPricePaise * item.qty,
      discountPaise: item.discountPaise,
      taxablePaise: item.taxablePaise,
      cgstPaise: supply === "intra" ? cgst : 0,
      sgstPaise: supply === "intra" ? item.taxPaise - cgst : 0,
      igstPaise: supply === "inter" ? item.taxPaise : 0,
      taxPaise: item.taxPaise,
      amountPaise: item.taxablePaise + item.taxPaise,
    };
  });

  const half = percentLabel(gstRatePct / 2);
  const row = (key: InvoiceTotalRow["key"], label: string, paise: number, strong = false): InvoiceTotalRow => ({
    key,
    label,
    paise,
    display: key === "discount" ? `${MINUS}${money(paise)}` : money(paise),
    strong,
  });
  const doc: InvoiceDocumentInput = input.document ?? { kind: "invoice" };
  const creditNote = doc.kind === "credit_note";
  const totalLabel = creditNote ? "Total credited" : isInvoice ? "Total paid" : "Total";
  const rows: InvoiceTotalRow[] = [row("subtotal", "Subtotal", totals.subtotalPaise)];
  if (totals.discountPaise > 0) {
    rows.push(row("discount", input.couponCode ? `Discount (${input.couponCode})` : "Discount", totals.discountPaise));
  }
  rows.push(row("taxable", "Taxable value", totals.taxablePaise));
  if (supply === "inter") {
    rows.push(row("igst", `IGST ${percentLabel(gstRatePct)}`, totals.igstPaise));
  } else {
    rows.push(row("cgst", `CGST ${half}`, totals.cgstPaise), row("sgst", `SGST ${half}`, totals.sgstPaise));
  }
  rows.push(row("total", totalLabel, totals.totalPaise, true));

  const created = toDate(input.createdAt);
  const placeCode = gstCodeForState(input.placeOfSupply);
  const number = input.invoice?.number ?? null;
  const extraNotes: string[] = [];
  let reference: InvoiceModel["reference"] = null;
  if (doc.kind === "credit_note") {
    const againstDate = formatDateIST(toDate(doc.against.issuedAt));
    reference = { label: "AGAINST INVOICE", value: `${doc.against.number} \u00B7 ${againstDate}` };
    extraNotes.push(`Issued to cancel tax invoice ${doc.against.number} dated ${againstDate} in full because the billing details were corrected.`);
    if (doc.replacedBy) extraNotes.push(`Replaced by tax invoice ${doc.replacedBy}.`);
  } else if (doc.replaces) {
    extraNotes.push(`This invoice replaces ${doc.replaces.invoiceNo}, cancelled by credit note ${doc.replaces.creditNoteNo} (billing details corrected).`);
  }
  const title = creditNote
    ? `Credit note ${number ?? ""}`.trim()
    : isInvoice && input.invoice
      ? `Tax invoice ${input.invoice.number}`
      : "Order summary";
  return {
    orderId: input.orderId,
    status: input.status,
    kind: creditNote ? "credit_note" : "invoice",
    docLabel: creditNote ? "Credit note" : "Tax invoice",
    numberLabel: creditNote ? "CREDIT NOTE NO." : "INVOICE NO.",
    dateLabel: creditNote ? "DATE" : "INVOICE DATE",
    reference,
    extraNotes,
    isInvoice,
    title,
    number: input.invoice?.number ?? null,
    invoiceDate: input.invoice ? formatDateIST(toDate(input.invoice.issuedAt)) : null,
    orderDateTime: formatOrderDateTime(created),
    orderDate: formatDateIST(created),
    seller: sellerParty(input.seller),
    buyer: buyerParty(input.billing),
    sac: input.sac,
    placeOfSupply: input.placeOfSupply,
    placeOfSupplyLabel: placeCode ? `${input.placeOfSupply} (${placeCode})` : input.placeOfSupply,
    supply,
    gstRatePct,
    rateLabel: percentLabel(gstRatePct),
    halfRateLabel: half,
    couponCode: input.couponCode,
    lines,
    totals: rows,
    totalPaise: totals.totalPaise,
    totalLabel,
    amountInWords: amountInWords(totals.totalPaise),
  };
}

/**
 * A safe download file name for a document number: invoice "AXS/26-27/1181" -> "Invoice-AXS-26-27-1181.pdf", credit
 * note "AXC/26-27/0004" -> "CreditNote-AXC-26-27-0004.pdf".
 */
export function documentFileName(kind: InvoiceDocumentKind, number: string): string {
  const safe = number
    .split("")
    .map((c) => (/[A-Za-z0-9-]/.test(c) ? c : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${kind === "credit_note" ? "CreditNote" : "Invoice"}-${safe || "order"}.pdf`;
}

/** A safe download file name for an invoice number: "AXS/26-27/1181" -> "Invoice-AXS-26-27-1181.pdf". */
export function invoiceFileName(number: string): string {
  return documentFileName("invoice", number);
}
