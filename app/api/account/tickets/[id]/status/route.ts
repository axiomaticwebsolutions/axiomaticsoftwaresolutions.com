/**
 * POST /api/account/tickets/:id/status { action: "resolve" | "reopen" } -> 200 { ticket, messages }.
 * Team permission `tickets.create`, CSRF + same origin, verified email. "resolve": open -> RESOLVED; "reopen":
 * RESOLVED -> OPEN. Repeating an action already in effect is a no-op. 409 `ticket_closed` (closed by support, or
 * resolved more than 14 days ago: start a new ticket), 409 `ticket_changed`; 404 outside the account.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { changeTicketStatus } from "@/lib/portal/tickets";
import { isTicketIdShape, ticketStatusSchema, TICKET_ACTION_BODY_MAX_BYTES } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "tickets.create", mutation: true });
  const { id } = await ctx.params;
  const { action } = await parseJsonBody(req, ticketStatusSchema, { maxBytes: TICKET_ACTION_BODY_MAX_BYTES });
  if (!isTicketIdShape(id)) throw errors.notFound("Ticket");
  enforce(await hit(db, RATE_LIMITS.ticketUpdate(member.user.id)));
  const detail = await changeTicketStatus({
    accountId: member.account.id,
    userId: member.user.id,
    role: member.membership.role,
    user: { id: member.user.id, name: member.user.name, email: member.user.email },
    ticketId: id,
    action,
  });
  return json(detail);
});
