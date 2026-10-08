/**
 * GET /api/admin/orders/:id/credit-notes/:noteId (orders.view): the credit note of a billing correction
 * (InvoiceCorrection id; credit note numbers contain "/") as a PDF, served inline for "Credit note PDF" in the drawer.
 * 404 for an unknown order or a note of another order. no-store (billing details are personal).
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { invoiceLogo } from "@/lib/branding/store";
import { db } from "@/lib/db";
import { errors } from "@/lib/http";
import { loadCreditNoteModel } from "@/lib/invoice/load";
import { documentFileName } from "@/lib/invoice/model";
import { renderInvoicePdf } from "@/lib/invoice/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string; noteId: string }>("orders.view", async ({ params }) => {
  const orderId = idParam(params, "id", "Order");
  const noteId = idParam(params, "noteId", "Credit note");
  const model = await loadCreditNoteModel(db, orderId, noteId);
  if (!model || !model.number) throw errors.notFound("Credit note");
  const pdf = await renderInvoicePdf(model, { logo: await invoiceLogo(db) });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
      "content-disposition": `inline; filename="${documentFileName("credit_note", model.number)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
