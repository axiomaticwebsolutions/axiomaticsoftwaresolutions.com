/**
 * POST /api/admin/tickets/:id/messages { body, internal = false, attachmentIds = [] } -> 201 { detail, messageId,
 * notified, emailed }.
 * A public reply moves the ticket to Awaiting customer, sets firstResponseAt once, assigns it to the replier when
 * nobody has it, and notifies the opener (portal notification + ticket_reply email through the outbox). An internal
 * note is visible to staff only and notifies nobody. Attachments: the caller's own uploads for this ticket
 * (POST .../uploads, then .../confirm). `tickets.manage`; 404 unknown ticket; 422 empty or too long text or
 * unavailable attachments; 409 `attachment_unavailable` when a file was attached concurrently.
 */
import { adminRoute } from "@/lib/admin/http";
import { ticketIdParam } from "@/lib/admin/tickets/params";
import { STAFF_MESSAGE_BODY_MAX_BYTES, staffMessageSchema } from "@/lib/admin/tickets/schema";
import { addStaffMessage } from "@/lib/admin/tickets/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>(
  "tickets.manage",
  async ({ params, body, staff, actor }) => {
    const ticketId = ticketIdParam(params);
    const data = await body(staffMessageSchema);
    const result = await addStaffMessage({ ticketId, data, staff: { id: staff.id, name: staff.name }, actor });
    return json(result, { status: 201 });
  },
  { maxBodyBytes: STAFF_MESSAGE_BODY_MAX_BYTES },
);
