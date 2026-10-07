/**
 * GET /api/orders/:id/invoice.pdf?t=: the order's tax invoice as a PDF (docs/decisions.md Phase 3 "Invoice"),
 * generated on demand from the Invoice seller snapshot and the order lines (lib/invoice).
 *
 * Access is the order page's (lib/orders/access): a member of the order's account with `invoices.view`, the
 * signed-in placer of an account-less order, or the order link token `t`. 401 signed out without a token,
 * 403 order_link_expired, 404 for unknown orders, bad tokens and orders the viewer may not see.
 * Only PAID, PARTIALLY_REFUNDED and REFUNDED orders have an invoice: 409 invoice_unavailable otherwise.
 * Rendering is CPU work, so it is limited to 30 PDFs / 10 min per IP. Content-Disposition: attachment;
 * Cache-Control: no-store (billing details are personal).
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { orderTokenFrom } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { ApiError, clientIp, route } from "@/lib/http";
import { loadInvoiceModel } from "@/lib/invoice/load";
import { invoiceFileName } from "@/lib/invoice/model";
import { renderInvoicePdf } from "@/lib/invoice/pdf";
import { log } from "@/lib/log";
import { resolveOrderAccess } from "@/lib/orders/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const INVOICE_UNAVAILABLE_MESSAGE = "The tax invoice is available once the payment is confirmed.";

export const GET = route<Context>(async (req, { params }) => {
  const { id } = await params;
  enforce(await hit(db, RATE_LIMITS.invoicePdfIp(clientIp(req))));
  const access = await resolveOrderAccess(id, { token: orderTokenFrom(req) });
  const model = await loadInvoiceModel(db, access.order.id);
  if (!model || !model.number) throw new ApiError(409, "invoice_unavailable", INVOICE_UNAVAILABLE_MESSAGE);

  const pdf = await renderInvoicePdf(model);
  log.info("invoice_pdf_served", { orderId: access.order.id, byOrderLink: access.viaToken, bytes: pdf.length });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
      "content-disposition": `attachment; filename="${invoiceFileName(model.number)}"`,
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
});
