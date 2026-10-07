/**
 * GET /api/account/uploads/:id/download -> 200 { url, expiresAt, fileName } (presigned GET, at most 10 minutes);
 * with `?redirect=1` -> 303 to that URL, so a plain link works. Team permission `tickets.view` (every role): files
 * attached to the customer-visible messages of this account's tickets, or the caller's own unsent upload. 404 for
 * anything else (other accounts, staff-only notes); 429 after 120 links an hour per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { attachmentDownloadLink } from "@/lib/portal/uploads";
import { isUploadIdShape } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "tickets.view" });
  const { id } = await ctx.params;
  if (!isUploadIdShape(id)) throw errors.notFound("Attachment");
  enforce(await hit(db, RATE_LIMITS.attachmentDownload(member.user.id)));
  const link = await attachmentDownloadLink({ accountId: member.account.id, userId: member.user.id, uploadId: id });
  if (req.nextUrl.searchParams.get("redirect") === "1") {
    return new Response(null, {
      status: 303,
      headers: { location: link.url, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }
  return json(link);
});
