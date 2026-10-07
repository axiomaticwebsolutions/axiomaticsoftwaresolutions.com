/**
 * GET /api/invites/:token -> 200 { invite: { email, accountName, role, roleLabel, roleDescription, inviterName,
 * expiresAt, accountExists, viewer: { signedIn, isInvitee } } }. Public (the token is the credential); read-only.
 * 404 `invite_invalid`, 410 `invite_used` | `invite_revoked` | `invite_expired`; 429 after 60 previews in 10 minutes
 * per IP. `accountExists`: the person already has a password, so they sign in to accept instead of creating one.
 */
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { clientIp, json, route } from "@/lib/http";
import { previewInvite } from "@/lib/portal/invites";
import { inviteTokenSchema } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  enforce(await hit(db, RATE_LIMITS.invitePreviewIp(clientIp(req))));
  // Next.js hands over the decoded segment; tokens are "<id>.<base64url>" and need no further decoding.
  const token = inviteTokenSchema.parse((await ctx.params).token);
  const auth = await getCurrentAuth();
  const invite = await previewInvite({ token, viewerUserId: auth?.user.id ?? null });
  return json({ invite }, { headers: { "cache-control": "no-store, max-age=0", "referrer-policy": "no-referrer" } });
});
