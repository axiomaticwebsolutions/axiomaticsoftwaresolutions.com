/**
 * GET /api/admin/renewals?q=&filter[window]=30|60|lapsed&sort=ends&page=&pageSize= (customers.view) -> { items, total,
 * page, pageSize }: licenses ending in the next 60 days or ended in the last 30.
 */
import { listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { RENEWAL_LIST_SPEC, type RenewalFilter, type RenewalSort } from "@/lib/admin/renewals/model";
import { listAdminRenewals } from "@/lib/admin/renewals/queries";
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const GET = adminRoute("customers.view", async ({ req }) => {
  const query = listQueryFromParsed<RenewalFilter, RenewalSort>(parseListQuery(req, RENEWAL_LIST_SPEC));
  const list = await listAdminRenewals(db, query, new Date());
  return json(pageResult(list.items, list.total, query));
});
