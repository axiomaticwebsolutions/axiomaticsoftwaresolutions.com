/**
 * GET /api/account/tickets?status=open|awaiting_customer|resolved|all&product=<id>|all&q=&sort=[-]updated|created|
 * priority|status|subject&page= -> 200 { tickets, total, page, pageSize, pageCount, counts }.
 * Team permission `tickets.view` (every role, Viewer included). Default: all statuses, most recently updated first,
 * 20 per page. 422 for an invalid query.
 *
 * POST /api/account/tickets { productId, licenseId?, subject, impact?: low|normal|high, body, attachmentIds?: [] }
 * -> 201 { ticket, messages } (the new ticket's detail). Team permission `tickets.create` (Owner, Billing admin,
 * Technical contact), CSRF + same origin, verified email. Subject 6-150 characters, body 20-10,000, up to 5 attachment
 * ids from POST /api/account/uploads (the caller's own, uploaded). 422 for an unknown product, a license outside the
 * account or product, or unavailable attachments; 429 after 10 new tickets an hour per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { createTicket, listTickets } from "@/lib/portal/tickets";
import { createTicketSchema, parseTicketListQuery, TICKET_BODY_MAX_BYTES } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "tickets.view" });
  const query = parseTicketListQuery(req.nextUrl.searchParams);
  return json(await listTickets({ accountId: member.account.id, query }));
});

export const POST = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "tickets.create", mutation: true });
  const data = await parseJsonBody(req, createTicketSchema, { maxBytes: TICKET_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.ticketCreate(member.user.id)));
  const detail = await createTicket({
    accountId: member.account.id,
    userId: member.user.id,
    role: member.membership.role,
    user: { id: member.user.id, name: member.user.name, email: member.user.email },
    data,
  });
  return json(detail, { status: 201 });
});
