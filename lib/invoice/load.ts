/**
 * Loads the tax invoice model of an order, or the credit note of one of its billing corrections, from the database
 * (server-only). Callers authorize first (lib/orders/access or the admin route); this module only reads.
 */
import "server-only";
import type { Db } from "@/lib/db";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { buildInvoiceModel, INVOICE_STATUSES, readSellerSnapshot, type InvoiceLineInput, type InvoiceModel } from "./model";

export type LoadInvoiceOptions = {
  /** GST rate used only when the totals cannot tell (zero taxable value). */
  fallbackGstRatePct?: number;
};

const ITEMS_INCLUDE = {
  orderBy: { id: "asc" },
  include: { plan: { select: { name: true, product: { select: { name: true, shortName: true } } } } },
} as const;

type LoadedItem = {
  kind: InvoiceLineInput["kind"];
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
  plan: { name: string; product: { name: string; shortName: string } };
};

function lineInputs(items: readonly LoadedItem[]): InvoiceLineInput[] {
  return items.map((item) => ({
    productName: item.plan.product.name,
    productShortName: item.plan.product.shortName,
    planName: item.plan.name,
    kind: item.kind,
    qty: item.quantity,
    unitPricePaise: item.unitPricePaise,
    discountPaise: item.discountPaise,
    taxablePaise: item.taxablePaise,
    taxPaise: item.taxPaise,
    targetLicenseId: item.targetLicenseId,
  }));
}

/**
 * The invoice model of a PAID, PARTIALLY_REFUNDED or REFUNDED order that has an Invoice row, or null otherwise.
 * Seller details come from the invoice's snapshot, so later settings edits never change a past invoice. A corrected
 * invoice (InvoiceCorrection.newInvoiceNo) carries the "This invoice replaces …" note.
 */
export async function loadInvoiceModel(db: Db, orderId: string, opts: LoadInvoiceOptions = {}): Promise<InvoiceModel | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { invoice: true, items: ITEMS_INCLUDE },
  });
  if (!order || !order.invoice || !INVOICE_STATUSES.has(order.status)) return null;
  const correction = await db.invoiceCorrection.findUnique({
    where: { newInvoiceNo: order.invoice.number },
    select: { originalInvoiceNo: true, creditNoteNo: true },
  });
  return buildInvoiceModel({
    orderId: order.id,
    status: order.status,
    createdAt: order.createdAt,
    invoice: { number: order.invoice.number, issuedAt: order.invoice.issuedAt },
    sac: order.invoice.sac,
    seller: readSellerSnapshot(order.invoice.seller),
    billing: readBillingSnapshot(order.billing),
    placeOfSupply: order.placeOfSupply,
    couponCode: order.couponCode,
    totals: {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      taxablePaise: order.taxablePaise,
      cgstPaise: order.cgstPaise,
      sgstPaise: order.sgstPaise,
      igstPaise: order.igstPaise,
      totalPaise: order.totalPaise,
    },
    items: lineInputs(order.items),
    fallbackGstRatePct: opts.fallbackGstRatePct,
    document: {
      kind: "invoice",
      replaces: correction ? { invoiceNo: correction.originalInvoiceNo, creditNoteNo: correction.creditNoteNo } : null,
    },
  });
}

/**
 * The credit note of billing correction `correctionId`, or null unless that correction belongs to order `orderId`.
 * It cancels the original invoice in full: billing from the original, seller from the correction, amounts from the
 * correction's columns (= the order's; amounts never change) and lines from the order items.
 */
export async function loadCreditNoteModel(db: Db, orderId: string, correctionId: string, opts: LoadInvoiceOptions = {}): Promise<InvoiceModel | null> {
  const correction = await db.invoiceCorrection.findUnique({ where: { id: correctionId } });
  if (!correction || correction.orderId !== orderId) return null;
  const order = await db.order.findUnique({ where: { id: orderId }, include: { items: ITEMS_INCLUDE } });
  if (!order) return null;
  return buildInvoiceModel({
    orderId: order.id,
    status: order.status,
    createdAt: order.createdAt,
    invoice: { number: correction.creditNoteNo, issuedAt: correction.issuedAt },
    sac: correction.sac,
    seller: readSellerSnapshot(correction.seller),
    billing: readBillingSnapshot(correction.originalBilling),
    placeOfSupply: order.placeOfSupply,
    couponCode: order.couponCode,
    totals: {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      taxablePaise: correction.taxablePaise,
      cgstPaise: correction.cgstPaise,
      sgstPaise: correction.sgstPaise,
      igstPaise: correction.igstPaise,
      totalPaise: correction.totalPaise,
    },
    items: lineInputs(order.items),
    fallbackGstRatePct: opts.fallbackGstRatePct,
    document: {
      kind: "credit_note",
      against: { number: correction.originalInvoiceNo, issuedAt: correction.originalIssuedAt },
      replacedBy: correction.newInvoiceNo,
    },
  });
}
