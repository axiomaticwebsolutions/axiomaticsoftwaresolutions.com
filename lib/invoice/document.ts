/**
 * The order's current tax invoice as a PDF file, the one place it is produced (server-only): the customer route
 * GET /api/orders/:id/invoice.pdf, the staff route GET /api/admin/orders/:id/invoice.pdf and the invoice attached to
 * the order_confirmation email (lib/email/attachments.ts) all call orderInvoicePdf(), so they serve the same document
 * under the same file name. The loader reads the order's Invoice row (after a billing correction, the replacement
 * number with its "This invoice replaces …" note), the renderer draws it with the uploaded light logo.
 * Callers authorize first; this module only reads.
 */
import "server-only";
import { invoiceLogo } from "@/lib/branding/store";
import type { Db } from "@/lib/db";
import { loadInvoiceModel } from "./load";
import { invoiceFileName } from "./model";
import { renderInvoicePdf } from "./pdf";

export type InvoicePdfFile = {
  /** The invoice number printed on the document ("AXS/26-27/1181"). */
  number: string;
  /** Download / attachment file name: "Invoice-AXS-26-27-1181.pdf". */
  fileName: string;
  pdf: Buffer;
};

/**
 * The tax invoice PDF of a PAID, PARTIALLY_REFUNDED or REFUNDED order that has an invoice, or null otherwise (the
 * routes answer 409 invoice_unavailable; the email goes without it). Renderer errors propagate.
 */
export async function orderInvoicePdf(client: Db, orderId: string): Promise<InvoicePdfFile | null> {
  const model = await loadInvoiceModel(client, orderId);
  if (!model || !model.number) return null;
  const pdf = await renderInvoicePdf(model, { logo: await invoiceLogo(client) });
  return { number: model.number, fileName: invoiceFileName(model.number), pdf };
}
