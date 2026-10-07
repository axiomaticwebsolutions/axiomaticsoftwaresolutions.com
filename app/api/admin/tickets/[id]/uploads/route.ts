/**
 * POST /api/admin/tickets/:id/uploads { fileName, contentType, sizeBytes } -> 201 { upload, put: { url, method,
 * headers, expiresAt } }. A staff attachment for this ticket: PNG, JPEG, PDF or TXT whose extension matches, 1 byte
 * to 10 MB, stored as a pending Upload of the ticket's account with the caller as uploader. PUT the file to `put.url`
 * with exactly `put.headers` (5 minutes), then POST .../uploads/:uploadId/confirm, then send its id in
 * `attachmentIds`. `tickets.manage`; 404 unknown ticket; 422 type or size; 429 after 30 an hour (or 25 unsent
 * files); 503 `upload_unavailable` when storage cannot sign.
 */
import { adminRoute } from "@/lib/admin/http";
import { ticketIdParam } from "@/lib/admin/tickets/params";
import { createStaffTicketUpload } from "@/lib/admin/tickets/uploads";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { UPLOAD_BODY_MAX_BYTES, uploadRequestSchema } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ id: string }>(
  "tickets.manage",
  async ({ params, body, staff }) => {
    const ticketId = ticketIdParam(params);
    const file = await body(uploadRequestSchema);
    enforce(await hit(db, RATE_LIMITS.uploadCreate(staff.id)));
    return json(await createStaffTicketUpload({ ticketId, staffId: staff.id, file }), { status: 201 });
  },
  { maxBodyBytes: UPLOAD_BODY_MAX_BYTES },
);
