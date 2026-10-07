/**
 * POST /api/account/uploads/:id/confirm (no body, or {}) -> 200 { upload: { ..., status: "ready" } }.
 * Checks that the file was PUT and has exactly the declared size. Only the uploader, in the same account.
 * Team permission `tickets.create`, CSRF + same origin. 404 for anyone else's upload, 409 `upload_attached`,
 * 409 `upload_missing` (nothing received yet), 422 `upload_mismatch` (the upload is discarded; attach it again).
 */
import { parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { confirmUpload } from "@/lib/portal/uploads";
import { isUploadIdShape } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "tickets.create", mutation: true });
  await parseEmptyBody(req);
  const { id } = await ctx.params;
  if (!isUploadIdShape(id)) throw errors.notFound("Attachment");
  enforce(await hit(db, RATE_LIMITS.uploadConfirm(member.user.id)));
  return json(await confirmUpload({ accountId: member.account.id, userId: member.user.id, uploadId: id }));
});
