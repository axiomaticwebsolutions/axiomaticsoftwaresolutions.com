/**
 * GET /api/admin/leads (leads.view) ?q=&filter[kind]=demo|contact&filter[status]=new|contacted|scheduled|closed|spam
 *     &sort=(-)received|name|status&page=&pageSize= -> { items: LeadDto[], total, page, pageSize, stats }
 */
import { adminRoute } from "@/lib/admin/http";
import { LEAD_LIST_SPEC } from "@/lib/admin/leads/model";
import { leadStats, listLeads } from "@/lib/admin/leads/service";
import { parseListQuery } from "@/lib/admin/list-query";
import { json } from "@/lib/http";

export const GET = adminRoute("leads.view", async ({ req }) => {
  const [page, stats] = await Promise.all([listLeads(parseListQuery(req, LEAD_LIST_SPEC)), leadStats()]);
  return json({ ...page, stats });
});
