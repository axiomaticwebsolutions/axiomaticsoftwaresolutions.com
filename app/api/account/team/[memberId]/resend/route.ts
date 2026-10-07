/**
 * POST /api/account/team/:memberId/resend (no body, or {}) -> 200 { member, inviteExpiresAt, emailSent }: emails a fresh 7-day
 * invitation link; the older links stop working. Team permission `team.manage` (Owner only), CSRF + same origin,
 * verified email. 409 `not_invited` once the person has joined; 404 outside the account; 429 after 3 resends an hour
 * for one invitation (and the per-owner / per-account invitation limits). The email is sent right after the commit and
 * never stored.
 */
import { parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { resendInvite } from "@/lib/portal/team";
import { isRecordIdShape } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ memberId: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "team.manage", mutation: true });
  await parseEmptyBody(req);
  const { memberId } = await ctx.params;
  if (!isRecordIdShape(memberId)) throw errors.notFound("Team member");
  enforce(await hit(db, RATE_LIMITS.teamInviteResend(member.account.id, memberId)));
  enforce(await hit(db, RATE_LIMITS.teamInviteUser(member.user.id)));
  enforce(await hit(db, RATE_LIMITS.teamInviteAccount(member.account.id)));
  const result = await resendInvite({
    accountId: member.account.id,
    actor: { id: member.user.id, name: member.user.name, email: member.user.email },
    memberId,
  });
  return json(result);
});
