/**
 * POST /api/admin/customers/:id/set-password-link { reason, userId? } (customers.manage) -> 201 { userId, email, url,
 * expiresAt, emailSent }: a single-use 7-day set-password link for an active customer member without a password (the
 * account's first active Owner, or `userId`). The link is shown ONCE (no-store), emailed directly, and never logged or
 * audited; older open links stop working. 422 reason (checked first), 404, 409 no_owner / member_invited /
 * not_customer / has_password, 422 userId, 429 (60 writes in 10 minutes per staff member; 5 links an hour per person).
 */
import { createSetPasswordLink } from "@/lib/admin/customers/actions";
import { customerDestructiveBody } from "@/lib/admin/customers/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("customers.manage", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Customer");
  const input = await body(customerDestructiveBody);
  enforce(await hit(db, RATE_LIMITS.adminCustomerWrite(staff.id)));
  return json(await createSetPasswordLink(id, input.userId, { staff, actor, input }), { status: 201 });
});
