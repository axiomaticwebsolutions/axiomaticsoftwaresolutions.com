import type { Metadata } from "next";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { INVITE_COPY, isInviteProblemCode } from "@/components/auth/invite-model";
import { InviteView, type InviteViewProps } from "@/components/auth/invite-view";
import {
  accountHome,
  authMetadata,
  currentAuthOrNull,
  firstParam,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { SignedInBanner } from "@/components/auth/signed-in-banner";
import type { CurrentAuth } from "@/lib/auth/guards";
import { hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { formatDateIST } from "@/lib/dates";
import { db } from "@/lib/db";
import { ApiError, clientIp, errors } from "@/lib/http";
import { log } from "@/lib/log";
import {
  INVITE_MESSAGES,
  previewInvite,
  signInToAcceptMessage,
  wrongAccountMessage,
} from "@/lib/portal/invites";
import { inviteTokenSchema } from "@/lib/validation/team";

export const metadata: Metadata = {
  ...authMetadata({
    title: "Accept invitation",
    description: "Join your team’s business account on Axiomatic.",
    path: "/invite",
  }),
  // The URL carries the invitation token: never send it on as a Referer.
  referrer: "no-referrer",
};

/**
 * The invitation for the token, read the way GET /api/invites/:token reads it (previewInvite, same per-IP limit),
 * or the reason it cannot be used (the API's codes and messages).
 */
async function loadInvite(raw: string | undefined, auth: CurrentAuth | null): Promise<InviteViewProps> {
  const signedIn = auth !== null;
  const accountHref = auth ? accountHome(auth) : "/account";
  const problem = (code: string, message: string): InviteViewProps => ({
    state: "problem",
    code: isInviteProblemCode(code) ? code : "invite_invalid",
    message,
    signedIn,
    accountHref,
  });
  const token = inviteTokenSchema.safeParse(raw ?? "");
  if (!token.success) return problem("invite_invalid", INVITE_MESSAGES.invalid);
  try {
    const limit = await hit(db, RATE_LIMITS.invitePreviewIp(clientIp({ headers: await headers() })));
    if (!limit.allowed) return problem("rate_limited", errors.rateLimited(limit.retryAfterSec).message);
    const invite = await previewInvite({ token: token.data, viewerUserId: auth?.user.id ?? null });
    return {
      state: "ready",
      token: token.data,
      invite: {
        email: invite.email,
        accountName: invite.accountName,
        roleLabel: invite.roleLabel,
        roleDescription: invite.roleDescription,
        inviterName: invite.inviterName,
        expiresLabel: formatDateIST(new Date(invite.expiresAt)),
        accountExists: invite.accountExists,
      },
      viewer: invite.viewer,
      accountHref,
      messages: { signInToAccept: signInToAcceptMessage(invite.email), wrongAccount: wrongAccountMessage(invite.email) },
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError) return problem(error.code, error.message);
    log.warn("invite_page_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return problem("unavailable", INVITE_COPY.unavailableMessage);
  }
}

/**
 * /invite?token=… from the team invitation email (decisions.md Phase 5 "Team"): preview, then accept as the signed-in
 * invitee, after signing in with the invited email, or as a new person with a name and password. Expired, revoked,
 * used and invalid links explain themselves. Success continues to /account.
 */
export default async function InvitePage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const auth = await currentAuthOrNull();
  const view = await loadInvite(firstParam(params.token), auth);
  const wrongPerson = view.state === "ready" && view.viewer.signedIn && !view.viewer.isInvitee;
  return (
    <>
      {auth ? <SignedInBanner email={auth.user.email} accountHref={wrongPerson || view.state === "problem" ? accountHome(auth) : null} /> : null}
      <InviteView {...view} />
    </>
  );
}
