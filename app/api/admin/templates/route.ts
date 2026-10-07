/**
 * GET /api/admin/templates (templates.manage) ?q=&filter[status]=active|draft|default&sort=(-)order|name|updated&page=
 *     &pageSize= -> { items: TemplateDto[], total, page, pageSize } (every template in the code catalogue plus stored rows)
 */
import { adminRoute } from "@/lib/admin/http";
import { pageResult, parseListQuery } from "@/lib/admin/list-query";
import { filterAndSortTemplates, TEMPLATE_LIST_SPEC } from "@/lib/admin/templates/model";
import { loadTemplates } from "@/lib/admin/templates/service";
import { json } from "@/lib/http";

export const GET = adminRoute("templates.manage", async ({ req }) => {
  const query = parseListQuery(req, TEMPLATE_LIST_SPEC);
  const rows = filterAndSortTemplates(await loadTemplates(), query);
  return json(pageResult(rows.slice(query.skip, query.skip + query.take), rows.length, query));
});
