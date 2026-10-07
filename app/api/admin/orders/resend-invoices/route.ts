/**
 * POST /api/admin/orders/resend-invoices { ids } (orders.resend_invoice): the bulk bar's "Resend invoices". Queues one
 * invoice email per invoiced order (one "Resent invoice" audit row each) and reports what was skipped and why.
 */
import { adminRoute } from "@/lib/admin/http";
import { resendInvoices } from "@/lib/admin/orders/resend";
import { resendBulkSchema } from "@/lib/admin/orders/schemas";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute("orders.resend_invoice", async ({ actor, body }) => {
  const { ids } = await body(resendBulkSchema);
  return json(await resendInvoices({ ids, actor }), { status: 202 });
});
