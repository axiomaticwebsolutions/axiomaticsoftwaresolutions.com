/** GET /api/admin/customers/:id (customers.view): the drawer (account, owner, members, licenses, orders, tickets). */
import { getAdminCustomerDetail } from "@/lib/admin/customers/queries";
import { adminRoute, idParam } from "@/lib/admin/http";
import { db } from "@/lib/db";
import { errors, json } from "@/lib/http";

export const GET = adminRoute<{ id: string }>("customers.view", async ({ params }) => {
  const customer = await getAdminCustomerDetail(db, idParam(params, "id", "Customer"), new Date());
  if (!customer) throw errors.notFound("Customer");
  return json({ customer });
});
