/**
 * Server-side authorization guards for route handlers, server actions and server components.
 * UI hiding is cosmetic; every protected route calls one of these. They throw ApiError (401/403), which
 * route() in lib/http.ts turns into the JSON error envelope. Pages should catch and redirect instead.
 * The active business account is always resolved on the server; an accountId from the client is never trusted.
 */
import "server-only";
import { cache } from "react";
import {
  MemberStatus,
  StaffStatus,
  type AccountMember,
  type BusinessAccount,
  type Session,
  type StaffRole,
  type User,
} from "@/generated/prisma/client";
import { readSessionToken, setSessionCookie } from "@/lib/auth/cookies";
import { resolveSession, type ResolvedSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { can, roleForbiddenMessage, teamCan, type Permission, type TeamPermission } from "@/lib/rbac";

export type CurrentAuth = ResolvedSession;
export type StaffAuth = { session: Session; user: User & { staffRole: StaffRole } };
export type AccountContext = {
  user: User;
  session: Session;
  account: BusinessAccount;
  membership: AccountMember;
};

export const TEAM_FORBIDDEN_MESSAGE = "Your team role doesn\u2019t allow this. Ask the account owner.";
export const NO_ACCOUNT_MESSAGE = "You\u2019re not a member of an active business account.";
/** 403 `email_unverified`: the portal, trials and team actions need a verified email (decisions.md Phase 3/5). */
export const EMAIL_UNVERIFIED_MESSAGE = "Verify your email to continue.";

/** The signed-in session and user for this request, or null. Resolved once per request (React cache). */
export const getCurrentAuth = cache(async (): Promise<CurrentAuth | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  const now = new Date();
  const auth = await resolveSession(db, token, now);
  if (auth && auth.session.lastSeenAt.getTime() === now.getTime()) {
    // The idle window slid forward; move the cookie expiry with it where this context may write cookies.
    try {
      await setSessionCookie(token, auth.session.expiresAt);
    } catch {
      // Server Component render: cookies are read-only here. The next route handler or action refreshes it.
    }
  }
  return auth;
});

/** Any signed-in user, else 401. */
export async function requireUser(): Promise<CurrentAuth> {
  const auth = await getCurrentAuth();
  if (!auth) throw errors.unauthorized();
  return auth;
}

/** A signed-in customer (not staff), else 401/403. */
export async function requireCustomer(): Promise<CurrentAuth> {
  const auth = await requireUser();
  if (auth.user.kind !== "CUSTOMER") throw errors.forbidden("Sign in with a customer account to continue.");
  return auth;
}

/** A signed-in customer whose email is verified, else 401/403 (`email_unverified`). */
export async function requireVerifiedCustomer(): Promise<CurrentAuth> {
  const auth = await requireCustomer();
  if (!auth.user.emailVerifiedAt) throw new ApiError(403, "email_unverified", EMAIL_UNVERIFIED_MESSAGE);
  return auth;
}

/** Staff whose console access is live: kind STAFF, ACTIVE, with a role (requireStaff, the admin shell, /api/me). */
export function hasLiveStaffAccess(user: Pick<User, "kind" | "staffRole" | "staffStatus">): boolean {
  return user.kind === "STAFF" && !!user.staffRole && user.staffStatus === StaffStatus.ACTIVE;
}

/** An active staff member, optionally holding `perm` (lib/rbac.ts), else 401/403. */
export async function requireStaff(perm?: Permission): Promise<StaffAuth> {
  const { session, user } = await requireUser();
  const role = user.staffRole;
  if (!role || !hasLiveStaffAccess(user)) throw errors.forbidden();
  if (perm && !can(role, perm)) throw errors.forbidden(roleForbiddenMessage(role));
  return { session, user: { ...user, staffRole: role } };
}

/**
 * The signed-in user's own settings (/api/me/password, /api/me/sessions, /api/me/two-step): customers, and staff only
 * while their console access is live (Admin > My profile). 403 for invited, deactivated or role-less staff.
 */
export function assertSelfService<A extends { user: Pick<User, "kind" | "staffRole" | "staffStatus"> }>(auth: A): A {
  if (auth.user.kind === "STAFF" && !hasLiveStaffAccess(auth.user)) throw errors.forbidden();
  return auth;
}

export type AccountRoleOptions = {
  /** Also require a verified email (portal pages and APIs, trials, team actions). */
  verified?: boolean;
};

type MembershipWithAccount = AccountMember & { account: BusinessAccount };

async function activeMembership(auth: CurrentAuth): Promise<MembershipWithAccount | null> {
  const { session, user } = auth;
  if (session.activeAccountId) {
    const chosen = await db.accountMember.findFirst({
      where: { accountId: session.activeAccountId, userId: user.id, status: MemberStatus.ACTIVE },
      include: { account: true },
    });
    if (chosen) return chosen;
  }
  const first = await db.accountMember.findFirst({
    where: { userId: user.id, status: MemberStatus.ACTIVE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { account: true },
  });
  if (first && first.accountId !== session.activeAccountId) {
    try {
      // Heal a stale or missing choice so later requests take the fast path.
      await db.session.update({ where: { id: session.id }, data: { activeAccountId: first.accountId } });
    } catch (error) {
      log.warn("active_account_update_failed", { sessionId: session.id, error });
    }
  }
  return first;
}

/**
 * The customer's active business account and membership, optionally requiring a team permission.
 * Active account = session.activeAccountId when the user is an ACTIVE member of it, else their first ACTIVE
 * membership. 401 when signed out, 403 when not a member of any account or the role lacks `teamPerm`.
 * With `{ verified: true }` an unverified email answers 403 `email_unverified` before the membership checks.
 */
export async function requireAccountRole(teamPerm?: TeamPermission, opts: AccountRoleOptions = {}): Promise<AccountContext> {
  const auth = opts.verified ? await requireVerifiedCustomer() : await requireCustomer();
  const membership = await activeMembership(auth);
  if (!membership) throw errors.forbidden(NO_ACCOUNT_MESSAGE, "no_account");
  if (teamPerm && !teamCan(membership.role, teamPerm)) throw errors.forbidden(TEAM_FORBIDDEN_MESSAGE);
  const { account, ...member } = membership;
  return {
    user: auth.user,
    session: { ...auth.session, activeAccountId: account.id },
    account,
    membership: member,
  };
}
