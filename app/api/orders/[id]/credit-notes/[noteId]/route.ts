/**
 * GET /api/orders/:id/credit-notes/:noteId?t=: the credit note of a billing correction of the order (Admin > Orders
 * "Correct billing") as a PDF. Access is the invoice PDF's (lib/orders/access): a member of the order's account with
 * `invoices.view`, the signed-in placer of an account-less order, or the order link token `t`. 401 signed out without a
 * token, 403 order_link_expired, 404 for unknown orders, bad tokens, orders the viewer may not see and notes of another
 * order. Limited like the invoice PDF (30 / 10 min per IP). attachment; no-store; nosniff.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { orderTokenFrom } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { clientIp, errors, route } from "@/lib/http";
import { loadCreditNoteModel } from "@/lib/invoice/load";
import { documentFileName } from "@/lib/invoice/model";
import { renderInvoicePdf } from "@/lib/invoice/pdf";
import { log } from "@/lib/log";
import { resolveOrderAccess } from "@/lib/orders/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; noteId: string }> };

const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const GET = route<Context>(async (req, { params }) => {
  const { id, noteId } = await params;
  enforce(await hit(db, RATE_LIMITS.invoicePdfIp(clientIp(req))));
  const access = await resolveOrderAccess(id, { token: orderTokenFrom(req) });
  if (!NOTE_ID_RE.test(noteId)) throw errors.notFound("Credit note");
  const model = await loadCreditNoteModel(db, access.order.id, noteId);
  if (!model || !model.number) throw errors.notFound("Credit note");

  const pdf = await renderInvoicePdf(model);
  log.info("credit_note_pdf_served", { orderId: access.order.id, byOrderLink: access.viaToken, bytes: pdf.length });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
      "content-disposition": `attachment; filename="${documentFileName("credit_note", model.number)}"`,
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
});
