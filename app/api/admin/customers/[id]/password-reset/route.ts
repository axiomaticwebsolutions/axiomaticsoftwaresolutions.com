/**
 * POST /api/admin/customers/:id/password-reset { userId? } (customers.manage): a password reset link for the
 * account's first active Owner (or the member `userId`) -> { userId, email, sent }. Audited; the link is emailed
 * directly and never returned or logged.
 */
import { sendCustomerPasswordReset } from "@/lib/admin/customers/actions";
import { customerEmailActionBody } from "@/lib/admin/customers/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("customers.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Customer");
  const input = await body(customerEmailActionBody);
  return json(await sendCustomerPasswordReset(id, input.userId, { actor }));
});
