/**
 * GET /api/admin/tickets/:id/attachments/:uploadId -> { url, expiresAt, fileName } (presigned GET, at most 10
 * minutes); with `?redirect=1` -> 303 to that URL, so a plain link works. Any file attached to a message of this
 * ticket (internal notes included) or the caller's own pending upload for it; 404 otherwise. `tickets.manage`;
 * 429 after 120 links an hour.
 */
import { adminRoute } from "@/lib/admin/http";
import { ticketIdParam, uploadIdParam } from "@/lib/admin/tickets/params";
import { staffAttachmentLink } from "@/lib/admin/tickets/uploads";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string; uploadId: string }>("tickets.manage", async ({ req, params, staff }) => {
  const ticketId = ticketIdParam(params);
  const uploadId = uploadIdParam(params);
  enforce(await hit(db, RATE_LIMITS.attachmentDownload(staff.id)));
  const link = await staffAttachmentLink({ ticketId, staffId: staff.id, uploadId });
  if (req.nextUrl.searchParams.get("redirect") === "1") {
    return new Response(null, { status: 303, headers: { location: link.url, "referrer-policy": "no-referrer" } });
  }
  return json(link);
});
