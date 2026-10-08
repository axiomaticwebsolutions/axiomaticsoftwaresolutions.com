import type { Metadata } from "next";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { accountHome, authMetadata, currentAuthOrNull, firstParam, type AuthSearchParams } from "@/components/auth/page-helpers";
import { SignedInBanner } from "@/components/auth/signed-in-banner";
import { isStaffInviteProblemCode, STAFF_INVITE_COPY } from "@/components/admin/staff/staff-invite-model";
import { StaffInviteView, type StaffInviteViewProps } from "@/components/admin/staff/staff-invite-view";
import { previewStaffInvite, signedInElsewhereMessage, STAFF_INVITE_MESSAGES } from "@/lib/admin/staff/invites";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { staffInviteTokenSchema } from "@/lib/admin/staff/model";
import type { CurrentAuth } from "@/lib/auth/guards";
import { hit } from "@/lib/auth/rate-limit";
import { formatDateIST } from "@/lib/dates";
import { db } from "@/lib/db";
import { ApiError, clientIp, errors } from "@/lib/http";
import { log } from "@/lib/log";

export const metadata: Metadata = {
  ...authMetadata({ title: "Accept staff invitation", description: "Join the Axiomatic admin console.", path: "/staff-invite" }),
  // The URL carries the invitation token: never send it on as a Referer.
  referrer: "no-referrer",
};

/** The invitation read the way GET /api/staff-invites/:token reads it (same per-IP limit), or why it cannot be used. */
async function loadInvite(raw: string | undefined, auth: CurrentAuth | null): Promise<StaffInviteViewProps> {
  const signedInHref = auth ? accountHome(auth) : null;
  const problem = (code: string, message: string): StaffInviteViewProps => ({
    state: "problem",
    code: isStaffInviteProblemCode(code) ? code : "invite_invalid",
    message,
    signedInHref,
  });
  const token = staffInviteTokenSchema.safeParse(raw ?? "");
  if (!token.success) return problem("invite_invalid", STAFF_INVITE_MESSAGES.invalid);
  try {
    const limit = await hit(db, STAFF_RATE_LIMITS.previewIp(clientIp({ headers: await headers() })));
    if (!limit.allowed) return problem("rate_limited", errors.rateLimited(limit.retryAfterSec).message);
    const invite = await previewStaffInvite({ token: token.data, viewer: auth ? { email: auth.user.email } : null });
    return {
      state: "ready",
      token: token.data,
      invite: {
        email: invite.email,
        roleLabel: invite.roleLabel,
        roleSummary: invite.roleSummary,
        inviterName: invite.inviterName,
        expiresLabel: formatDateIST(new Date(invite.expiresAt)),
      },
      signedInMessage: auth ? signedInElsewhereMessage(auth.user.email) : null,
      signedInHref,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError) return problem(error.code, error.message);
    log.warn("staff_invite_page_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return problem("unavailable", STAFF_INVITE_COPY.unavailableMessage);
  }
}

/**
 * /staff-invite?token=… from the staff invitation email (decisions.md Phase 6 "Staff"): the invitation, then the
 * person's name and password. Accepting signs them in to /admin (two-step sign-in off until they turn it on in
 * Admin > My profile).
 */
export default async function StaffInvitePage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const auth = await currentAuthOrNull();
  const view = await loadInvite(firstParam(params.token), auth);
  return (
    <>
      {auth ? <SignedInBanner email={auth.user.email} accountHref={accountHome(auth)} /> : null}
      <StaffInviteView {...view} />
    </>
  );
}
