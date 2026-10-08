/**
 * GET /api/admin/orders/:id/invoice.pdf (orders.view): the order's tax invoice for staff ("View invoice" opens it in a
 * new tab, so it is served inline). Same document as the customer's /api/orders/:id/invoice.pdf and the order email's
 * attachment (lib/invoice/document.ts orderInvoicePdf). 404 unknown order, 409 invoice_unavailable before payment.
 * no-store (billing details are personal).
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { orderInvoicePdf } from "@/lib/invoice/document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string }>("orders.view", async ({ params }) => {
  const orderId = idParam(params, "id", "Order");
  const exists = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) throw errors.notFound("Order");
  const file = await orderInvoicePdf(db, orderId);
  if (!file) {
    throw new ApiError(409, "invoice_unavailable", "The tax invoice is available once the payment is confirmed.");
  }
  const { pdf } = file;
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
      "content-disposition": `inline; filename="${file.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
