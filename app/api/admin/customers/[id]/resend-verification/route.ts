/**
 * POST /api/admin/customers/:id/resend-verification { userId? } (customers.manage): a new email verification code
 * for the account's first active Owner (or the member `userId`) -> { userId, email, sent }. Audited; the code is
 * emailed directly and never returned or logged.
 */
import { resendCustomerVerification } from "@/lib/admin/customers/actions";
import { customerEmailActionBody } from "@/lib/admin/customers/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("customers.manage", async ({ params, body, actor }) => {
  const id = idParam(params, "id", "Customer");
  const input = await body(customerEmailActionBody);
  return json(await resendCustomerVerification(id, input.userId, { actor }));
});
