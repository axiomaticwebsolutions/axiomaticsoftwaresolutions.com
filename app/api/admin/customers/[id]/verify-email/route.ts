/**
 * POST /api/admin/customers/:id/verify-email { reason, userId? } (customers.verify_email) -> { userId, email, changed,
 * claimedOrders }: marks the account's first active Owner's (or the member `userId`'s) email verified, voids their
 * open verification codes and moves guest orders of that address into the account they own, as code verification
 * does. Idempotent: an already verified email answers `changed: false` and writes nothing. 422 reason (checked
 * first), 404, 409 no_owner / member_invited / not_customer, 422 userId, 429.
 */
import { markCustomerEmailVerified } from "@/lib/admin/customers/records";
import { customerDestructiveBody } from "@/lib/admin/customers/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const POST = adminRoute<{ id: string }>("customers.verify_email", async ({ params, staff, actor, body }) => {
  const id = idParam(params, "id", "Customer");
  const input = await body(customerDestructiveBody);
  enforce(await hit(db, RATE_LIMITS.adminCustomerWrite(staff.id)));
  return json(await markCustomerEmailVerified(id, input.userId, { staff, actor, input }));
});
