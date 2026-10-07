/**
 * Loads the tax invoice model of an order from the database (server-only). Callers authorize first
 * (lib/orders/access); this module only reads.
 */
import "server-only";
import type { Db } from "@/lib/db";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { buildInvoiceModel, INVOICE_STATUSES, readSellerSnapshot, type InvoiceModel } from "./model";

export type LoadInvoiceOptions = {
  /** GST rate used only when the totals cannot tell (zero taxable value). */
  fallbackGstRatePct?: number;
};

/**
 * The invoice model of a PAID, PARTIALLY_REFUNDED or REFUNDED order that has an Invoice row, or null otherwise.
 * Seller details come from the invoice's snapshot, so later settings edits never change a past invoice.
 */
export async function loadInvoiceModel(db: Db, orderId: string, opts: LoadInvoiceOptions = {}): Promise<InvoiceModel | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      invoice: true,
      items: {
        orderBy: { id: "asc" },
        include: { plan: { select: { name: true, product: { select: { name: true, shortName: true } } } } },
      },
    },
  });
  if (!order || !order.invoice || !INVOICE_STATUSES.has(order.status)) return null;
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
    items: order.items.map((item) => ({
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
    })),
    fallbackGstRatePct: opts.fallbackGstRatePct,
  });
}
