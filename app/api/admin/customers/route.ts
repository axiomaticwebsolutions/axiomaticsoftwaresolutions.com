/**
 * GET /api/admin/customers?q=&filter[gst|state]=&sort=-ltv&page=&pageSize= (customers.view) -> { items, total, page,
 * pageSize }: business accounts with their owner, active licenses, paid orders, lifetime value and last order.
 *
 * POST /api/admin/customers { name, email, phone?, legalName?, gstin?, address?, city?, state?, pin?, emailVerified?,
 * reason } (customers.create; `emailVerified: true` also needs customers.verify_email) -> 201 { accountId, userId,
 * email, emailVerified, claimedOrders, setPassword: { url, expiresAt }, emailSent }: a customer without a password, the
 * business account they own and a single-use 7-day set-password link, returned once (never logged or audited) and
 * emailed directly. 422 validation_failed / reason_required, 409 email_taken (details.accountId when it is a
 * customer's), 429 after 30 an hour per staff member.
 */
import { createCustomer } from "@/lib/admin/customers/records";
import { CUSTOMER_LIST_SPEC, type CustomerFilter, type CustomerSort } from "@/lib/admin/customers/model";
import { listAdminCustomers } from "@/lib/admin/customers/queries";
import { customerCreateBody } from "@/lib/admin/customers/schemas";
import { listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const GET = adminRoute("customers.view", async ({ req }) => {
  const query = listQueryFromParsed<CustomerFilter, CustomerSort>(parseListQuery(req, CUSTOMER_LIST_SPEC));
  const list = await listAdminCustomers(db, query, new Date());
  return json(pageResult(list.items, list.total, query));
});

export const POST = adminRoute("customers.create", async ({ staff, actor, body, requirePerm }) => {
  const input = await body(customerCreateBody);
  enforce(await hit(db, RATE_LIMITS.adminCustomerCreate(staff.id)));
  if (input.emailVerified === true) requirePerm("customers.verify_email");
  return json(await createCustomer(input, { staff, actor }), { status: 201 });
});
