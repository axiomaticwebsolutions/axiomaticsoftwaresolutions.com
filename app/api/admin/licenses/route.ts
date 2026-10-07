/**
 * GET /api/admin/licenses?q=&filter[status|product|devices]=&sort=-issued&page=&pageSize= (any staff; Finance reads
 * only) -> { items, total, page, pageSize }. POST /api/admin/licenses: manual issue { accountId, planId, quantity?,
 * reason } (licenses.manage) -> 201 { license: { id, keyMasked, productName, planName, emailedTo } }; the key itself is
 * never returned (the account owner gets the license_issued email).
 */
import { issueManualLicense } from "@/lib/admin/licenses/actions";
import { listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { LICENSE_LIST_SPEC, type LicenseFilter, type LicenseSort } from "@/lib/admin/licenses/model";
import { listAdminLicenses } from "@/lib/admin/licenses/queries";
import { manualIssueBody } from "@/lib/admin/licenses/schemas";
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const GET = adminRoute(null, async ({ req }) => {
  const query = listQueryFromParsed<LicenseFilter, LicenseSort>(parseListQuery(req, LICENSE_LIST_SPEC));
  const list = await listAdminLicenses(db, query, new Date());
  return json(pageResult(list.items, list.total, query));
});

export const POST = adminRoute("licenses.manage", async ({ body, staff, actor }) => {
  const input = await body(manualIssueBody);
  const license = await issueManualLicense(
    { accountId: input.accountId, planId: input.planId, quantity: input.quantity },
    { staff, actor, input },
  );
  return json({ license }, { status: 201 });
});
