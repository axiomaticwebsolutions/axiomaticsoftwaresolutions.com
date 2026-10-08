/**
 * POST /api/admin/orders/:id/correct-billing { billing: { name?, phone?, business?, address?, city?, pin?, gstin? },
 * reason } (invoices.correct: Owner, Finance) -> 201 { correction: { id, creditNoteNo, originalInvoiceNo, newInvoiceNo,
 * issuedAt }, order }: in one transaction a credit note cancelling the current invoice in full and a new invoice with
 * the corrected details (lib/admin/orders/correction.ts). Amounts, licenses and the payment never change. 422
 * reason_required / validation_failed (billing.state, billing.email, billing.gstin, ...) / nothing_changed, 404,
 * 409 not_correctable / seller_state_changed / invoice_series_exhausted, 429.
 */
import { adminRoute, idParam } from "@/lib/admin/http";
import { correctOrderBilling } from "@/lib/admin/orders/correction";
import { billingCorrectionBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>("invoices.correct", async ({ params, staff, actor, body }) => {
  const orderId = idParam(params, "id", "Order");
  const input = await body(billingCorrectionBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderWrite(staff.id)));
  return json(await correctOrderBilling(orderId, input, { staff, actor }), { status: 201 });
});
