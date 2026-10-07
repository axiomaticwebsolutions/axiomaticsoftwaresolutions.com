/**
 * POST /api/account/tickets/:id/messages { body, attachmentIds?: [] } -> 201 { ticket, messages }.
 * Team permission `tickets.create`, CSRF + same origin, verified email. A reply to a ticket waiting for the customer
 * moves it back to "Waiting for support" (OPEN). 409 `ticket_resolved` (reopen it first), 409 `ticket_closed`,
 * 409 `ticket_changed`; 422 "Write a message before sending." or unavailable attachments; 404 outside the account;
 * 429 after 60 ticket updates an hour per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { replyToTicket } from "@/lib/portal/tickets";
import { isTicketIdShape, TICKET_BODY_MAX_BYTES, ticketReplySchema } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "tickets.create", mutation: true });
  const { id } = await ctx.params;
  const data = await parseJsonBody(req, ticketReplySchema, { maxBytes: TICKET_BODY_MAX_BYTES });
  if (!isTicketIdShape(id)) throw errors.notFound("Ticket");
  enforce(await hit(db, RATE_LIMITS.ticketUpdate(member.user.id)));
  const detail = await replyToTicket({
    accountId: member.account.id,
    userId: member.user.id,
    role: member.membership.role,
    user: { id: member.user.id, name: member.user.name, email: member.user.email },
    ticketId: id,
    data,
  });
  return json(detail, { status: 201 });
});
