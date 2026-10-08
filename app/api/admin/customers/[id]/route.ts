/**
 * GET /api/admin/customers/:id (customers.view): the drawer (account, owner, members, licenses, orders, tickets).
 *
 * PATCH /api/admin/customers/:id { name?, phone?, email?, legalName?, gstin?, address?, city?, state?, pin?,
 * emailVerified?, reason } (customers.edit; `emailVerified: true` with a new email also needs customers.verify_email)
 * -> { customer, changed, signedOut, claimedOrders }. Person fields change the account's first active Owner (in every
 * account they are in). An email change bumps the security epoch, signs them out everywhere, voids open tokens (team
 * invitations included), clears verification unless ticked (ticked: the new address's guest orders move in and are
 * listed in the audit row) and emails the old address. 422 reason_required / validation_failed / emailVerified, 404, 409
 * no_owner / not_customer / email_taken, 429 after 60 writes in 10 minutes per staff member.
 */
import { getAdminCustomerDetail } from "@/lib/admin/customers/queries";
import { updateCustomer } from "@/lib/admin/customers/records";
import { customerPatchBody } from "@/lib/admin/customers/schemas";
import { adminRoute, idParam } from "@/lib/admin/http";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json } from "@/lib/http";

export const GET = adminRoute<{ id: string }>("customers.view", async ({ params }) => {
  const customer = await getAdminCustomerDetail(db, idParam(params, "id", "Customer"), new Date());
  if (!customer) throw errors.notFound("Customer");
  return json({ customer });
});

export const PATCH = adminRoute<{ id: string }>("customers.edit", async ({ params, staff, actor, body, requirePerm }) => {
  const id = idParam(params, "id", "Customer");
  const input = await body(customerPatchBody);
  enforce(await hit(db, RATE_LIMITS.adminCustomerWrite(staff.id)));
  if (input.emailVerified === true) requirePerm("customers.verify_email");
  return json(await updateCustomer(id, input, { staff, actor }));
});
