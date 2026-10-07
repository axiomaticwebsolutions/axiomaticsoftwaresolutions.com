/**
 * GET /api/admin/tickets?q=&filter[status]=&filter[priority]=&filter[assignee]=me|none|<staffId>&filter[product]=
 * &sort=-updatedAt&page=1&pageSize=25 -> { items: AdminTicketRow[], total, page, pageSize }.
 * Status filters are as shown (open, awaiting_customer, resolved, closed: RESOLVED reads as Closed 14 days after
 * resolution); search covers id, subject, business and the customer's name or email. `tickets.manage`.
 */
import { adminRoute } from "@/lib/admin/http";
import { parseAdminTicketQuery } from "@/lib/admin/tickets/model";
import { listAdminTickets } from "@/lib/admin/tickets/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("tickets.manage", async ({ req, staff }) => {
  return json(await listAdminTickets({ query: parseAdminTicketQuery(req), staffId: staff.id }));
});
