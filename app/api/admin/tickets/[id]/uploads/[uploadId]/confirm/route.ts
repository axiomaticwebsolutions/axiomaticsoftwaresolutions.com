/**
 * POST /api/admin/tickets/:id/uploads/:uploadId/confirm (no body, or {}) -> { upload: { ..., status: "ready" } }.
 * The file was PUT with exactly the declared size. Only the staff member who uploaded it, for this ticket's account.
 * `tickets.manage`; 404 for anyone else's upload, 409 `upload_attached` / `upload_missing`, 422 `upload_mismatch`
 * (the upload is discarded); 429 after 60 an hour.
 */
import { adminRoute } from "@/lib/admin/http";
import { ticketIdParam, uploadIdParam } from "@/lib/admin/tickets/params";
import { confirmStaffTicketUpload } from "@/lib/admin/tickets/uploads";
import { parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string; uploadId: string }>("tickets.manage", async ({ req, params, staff }) => {
  const ticketId = ticketIdParam(params);
  const uploadId = uploadIdParam(params);
  await parseEmptyBody(req);
  enforce(await hit(db, RATE_LIMITS.uploadConfirm(staff.id)));
  return json(await confirmStaffTicketUpload({ ticketId, staffId: staff.id, uploadId }));
});
