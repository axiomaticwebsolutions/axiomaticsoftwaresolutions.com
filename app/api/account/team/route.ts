/**
 * GET /api/account/team -> 200 { members, counts: { active, invited }, limit }.
 * POST /api/account/team { email, role: BILLING|TECHNICAL|VIEWER } -> 201 { member, inviteExpiresAt, emailSent }: invites by
 * email (lower-cased) and sends the team_invite email with a 7-day link; logs "Invited team member".
 * Team permission `team.manage` (Owner only), verified email; POST also CSRF + same origin. 409 `already_member`
 * ("This person is already on your team.", also as fieldErrors.email), 409 `team_full`, 422 (invalid email, staff
 * address, Owner role); 429 after 20 invitations an hour per owner or 50 a day per account.
 * The invitation email holds the link, so it is sent right after the commit and never stored (emailSent false: it
 * could not be sent; resend it).
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { inviteMember, listTeam } from "@/lib/portal/team";
import { inviteMemberSchema, TEAM_BODY_MAX_BYTES } from "@/lib/validation/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "team.manage" });
  return json(await listTeam({ accountId: member.account.id, viewerUserId: member.user.id }));
});

export const POST = route(async (req) => {
  const member = await requireLicenseMember(req, { perm: "team.manage", mutation: true });
  const data = await parseJsonBody(req, inviteMemberSchema, { maxBytes: TEAM_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.teamInviteUser(member.user.id)));
  enforce(await hit(db, RATE_LIMITS.teamInviteAccount(member.account.id)));
  const result = await inviteMember({
    accountId: member.account.id,
    actor: { id: member.user.id, name: member.user.name, email: member.user.email },
    data,
  });
  return json(result, { status: 201 });
});
