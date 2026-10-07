/**
 * GET /api/staff-invites/:token -> 200 { invite: { email, role, roleLabel, roleSummary, twoStep, inviterName,
 * expiresAt, viewer: { signedIn, email } } }. Public (the token is the credential) and read-only.
 * 404 `invite_invalid`, 410 `invite_used` | `invite_revoked` | `invite_expired`; 429 after 60 previews in 10 minutes
 * per IP. Never cached, never sent on as a Referer.
 */
import { STAFF_INVITE_MESSAGES, previewStaffInvite } from "@/lib/admin/staff/invites";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { staffInviteTokenSchema } from "@/lib/admin/staff/model";
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { ApiError, clientIp, json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  enforce(await hit(db, STAFF_RATE_LIMITS.previewIp(clientIp(req))));
  // Next.js hands over the decoded segment; tokens are "<id>.<base64url>".
  const token = staffInviteTokenSchema.safeParse((await ctx.params).token);
  if (!token.success) throw new ApiError(404, "invite_invalid", STAFF_INVITE_MESSAGES.invalid);
  const auth = await getCurrentAuth();
  const invite = await previewStaffInvite({ token: token.data, viewer: auth ? { email: auth.user.email } : null });
  return json({ invite }, { headers: { "cache-control": "no-store, max-age=0", "referrer-policy": "no-referrer" } });
});
