/**
 * PATCH /api/account/team/:memberId { role: OWNER|BILLING|TECHNICAL|VIEWER } -> 200 { member }: applies at once and
 * logs "Changed role" (the same role again is a no-op). 403 `own_role`, 409 `last_owner`, 422 for making a pending
 * invitee an Owner.
 * DELETE /api/account/team/:memberId -> 200 { removed: "member" | "invite", memberId }: removes a member (logs
 * "Removed team member"; their sessions stop using this account) or revokes an invitation (links stop working; logs
 * "Revoked invite"). 403 `remove_self`, 409 `last_owner`.
 * Team permission `team.manage` (Owner only), CSRF + same origin, verified email. 404 for members of other accounts.
 * 429 after 60 changes in 10 minutes per owner.
 */
import { parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { changeMemberRole, removeMember } from "@/lib/portal/team";
import { isRecordIdShape } from "@/lib/validation/license-actions";
import { changeRoleSchema, TEAM_BODY_MAX_BYTES } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ memberId: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "team.manage", mutation: true });
  const { role } = await parseJsonBody(req, changeRoleSchema, { maxBytes: TEAM_BODY_MAX_BYTES });
  const { memberId } = await ctx.params;
  if (!isRecordIdShape(memberId)) throw errors.notFound("Team member");
  enforce(await hit(db, RATE_LIMITS.teamChange(member.user.id)));
  return json(
    await changeMemberRole({
      accountId: member.account.id,
      actor: { id: member.user.id, name: member.user.name, email: member.user.email },
      memberId,
      role,
    }),
  );
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "team.manage", mutation: true });
  await parseEmptyBody(req);
  const { memberId } = await ctx.params;
  if (!isRecordIdShape(memberId)) throw errors.notFound("Team member");
  enforce(await hit(db, RATE_LIMITS.teamChange(member.user.id)));
  return json(
    await removeMember({
      accountId: member.account.id,
      actor: { id: member.user.id, name: member.user.name, email: member.user.email },
      memberId,
    }),
  );
});
