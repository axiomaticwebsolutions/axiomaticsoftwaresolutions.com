/**
 * GET   /api/admin/tickets/:id -> { ticket, messages } (every message, internal notes included, oldest first).
 * PATCH /api/admin/tickets/:id { status?, priority?, assigneeId? (null = unassigned) } -> { detail, changed }.
 *   Each change writes its own audit row in one transaction; assignees must be active staff who handle tickets
 *   (422 `assigneeId`). `tickets.manage`; 404 for unknown ids.
 */
import { adminRoute } from "@/lib/admin/http";
import { ticketIdParam } from "@/lib/admin/tickets/params";
import { TICKET_PATCH_BODY_MAX_BYTES, ticketPatchSchema } from "@/lib/admin/tickets/schema";
import { getAdminTicket, updateAdminTicket } from "@/lib/admin/tickets/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = adminRoute<Params>("tickets.manage", async ({ params }) => {
  return json(await getAdminTicket({ ticketId: ticketIdParam(params) }));
});

export const PATCH = adminRoute<Params>(
  "tickets.manage",
  async ({ params, body, staff, actor }) => {
    const ticketId = ticketIdParam(params);
    const patch = await body(ticketPatchSchema);
    return json(await updateAdminTicket({ ticketId, patch, staff: { id: staff.id, name: staff.name }, actor }));
  },
  { maxBodyBytes: TICKET_PATCH_BODY_MAX_BYTES },
);
