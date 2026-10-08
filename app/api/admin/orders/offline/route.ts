/**
 * POST /api/admin/orders/offline { requestId, accountId, items, couponCode?, billing, method, reference?, receivedOn,
 * amountPaise, reason } (payments.record_offline: Owner, Finance) -> 201 { orderId, status: "paid", invoiceNumber,
 * licensesIssued, licensesUpdated, totalPaise, replayed }: the order and its offline payment (cash, UPI, bank transfer,
 * cheque, other) in ONE transaction, fulfilled by the payment webhook's own code (licenses, tax invoice, emails). The
 * one documented exception to "licenses only from the webhook" (docs/security.md "Offline payments"). The amount must
 * equal the server total. A repeat of the same requestId answers 200 with the first order (`replayed: true`).
 * 422 reason_required / receivedOn / amountPaise / reference / cart errors, 404 Customer, 409 fulfilment_failed /
 * duplicate_request, 429 after 30 an hour per staff member (shared with POST /api/admin/orders).
 */
import { adminRoute } from "@/lib/admin/http";
import { createOfflinePaidOrder } from "@/lib/admin/orders/offline";
import { offlineOrderBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute("payments.record_offline", async ({ staff, actor, body }) => {
  const input = await body(offlineOrderBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderCreate(staff.id)));
  const result = await createOfflinePaidOrder(input, { staff, actor });
  return json(result, { status: result.replayed ? 200 : 201 });
});
