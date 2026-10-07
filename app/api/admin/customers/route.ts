/**
 * GET /api/admin/customers?q=&filter[gst|state]=&sort=-ltv&page=&pageSize= (customers.view) -> { items, total, page,
 * pageSize }: business accounts with their owner, active licenses, paid orders, lifetime value and last order.
 */
import { CUSTOMER_LIST_SPEC, type CustomerFilter, type CustomerSort } from "@/lib/admin/customers/model";
import { listAdminCustomers } from "@/lib/admin/customers/queries";
import { listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const GET = adminRoute("customers.view", async ({ req }) => {
  const query = listQueryFromParsed<CustomerFilter, CustomerSort>(parseListQuery(req, CUSTOMER_LIST_SPEC));
  const list = await listAdminCustomers(db, query, new Date());
  return json(pageResult(list.items, list.total, query));
});
