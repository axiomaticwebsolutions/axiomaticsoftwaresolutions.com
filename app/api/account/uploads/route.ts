/**
 * POST /api/account/uploads { fileName, contentType, sizeBytes } -> 201 { upload, put: { url, method: "PUT", headers,
 * expiresAt } }. One ticket attachment: PNG, JPEG, PDF or TXT whose extension matches the type, 1 byte to 10 MB.
 * The browser PUTs the file to `put.url` with exactly `put.headers` (valid 5 minutes), then calls
 * POST /api/account/uploads/:id/confirm, and passes the id in `attachmentIds` when it sends the ticket or reply.
 * Team permission `tickets.create`, CSRF + same origin, verified email. 422 for other types or sizes; 429 after 30
 * uploads an hour per user (or 25 unsent files); 503 `upload_unavailable` when storage cannot sign.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { createUpload } from "@/lib/portal/uploads";
import { UPLOAD_BODY_MAX_BYTES, uploadRequestSchema } from "@/lib/validation/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "tickets.create", mutation: true });
  const file = await parseJsonBody(req, uploadRequestSchema, { maxBytes: UPLOAD_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.uploadCreate(member.user.id)));
  const result = await createUpload({ accountId: member.account.id, userId: member.user.id, file });
  return json(result, { status: 201 });
});
