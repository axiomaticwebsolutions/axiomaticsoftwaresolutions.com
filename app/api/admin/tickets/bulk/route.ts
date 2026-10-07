/**
 * POST /api/admin/tickets/bulk { action: "assign_to_me" | "resolve", ids: string[] (1-100) } -> { updated,
 * unchanged, missing } (prototype bulk bar "Assign to me" / "Mark resolved"). One transaction, one audit row per
 * ticket changed; tickets already in that state are reported as unchanged, unknown ids as missing. `tickets.manage`.
 */
import { adminRoute } from "@/lib/admin/http";
import { TICKET_BULK_BODY_MAX_BYTES, ticketBulkSchema } from "@/lib/admin/tickets/schema";
import { bulkUpdateTickets } from "@/lib/admin/tickets/service";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute(
  "tickets.manage",
  async ({ body, staff, actor }) => {
    const data = await body(ticketBulkSchema);
    return json(await bulkUpdateTickets({ data, staff: { id: staff.id, name: staff.name }, actor }));
  },
  { maxBodyBytes: TICKET_BULK_BODY_MAX_BYTES },
);
