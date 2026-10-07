/**
 * GET /api/account/tickets/:id -> 200 { ticket, messages }.
 * Team permission `tickets.view` (every role). Messages are the customer-visible ones, oldest first (staff-only notes
 * are never returned); `ticket.canReply|canResolve|canReopen` reflect the viewer's role and the ticket's status.
 * 404 for unknown ids and other accounts' tickets.
 */
import { errors, json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { getTicketDetail } from "@/lib/portal/tickets";
import { isTicketIdShape } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "tickets.view" });
  const { id } = await ctx.params;
  if (!isTicketIdShape(id)) throw errors.notFound("Ticket");
  return json(
    await getTicketDetail({ accountId: member.account.id, userId: member.user.id, role: member.membership.role, ticketId: id }),
  );
});
