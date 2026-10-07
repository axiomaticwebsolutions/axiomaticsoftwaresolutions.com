/**
 * Who is checking out. Resolved on the server from the session (never from client ids):
 * - guest: no session. NEW items only; the order has no account (claimed later by the verified email).
 * - customer: a signed-in customer and their active business account membership (session.activeAccountId when the
 *   user is an ACTIVE member of it, else their first ACTIVE membership, as lib/auth/guards does). Orders belong to
 *   that account; only roles with the `purchases` team permission (Owner, Billing) may place them.
 *   A customer without any membership buys like a guest, but the order records who placed it.
 * - staff: staff sessions can quote (NEW items only) but cannot place customer orders.
 */
import { MemberStatus, type AccountMember, type BusinessAccount, type Session, type User } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { teamCan } from "@/lib/rbac";

export type BuyerMembership = AccountMember & { account: BusinessAccount };

export type CheckoutBuyer =
  | { kind: "guest" }
  | { kind: "staff"; user: User; session: Session }
  | { kind: "customer"; user: User; session: Session; membership: BuyerMembership | null };

/** Same copy as TEAM_FORBIDDEN_MESSAGE in lib/auth/guards.ts (kept here so this module stays free of next/headers). */
export const PURCHASE_FORBIDDEN_MESSAGE = "Your team role doesn’t allow this. Ask the account owner.";
export const STAFF_CHECKOUT_MESSAGE = "Sign in with a customer account to buy software.";
/** Same copy as NO_ACCOUNT_MESSAGE in lib/auth/guards.ts. */
export const NO_ACCOUNT_MESSAGE = "You’re not a member of an active business account.";

/** The buyer for a resolved session (or null when signed out). */
export async function resolveCheckoutBuyer(db: Db, auth: { user: User; session: Session } | null): Promise<CheckoutBuyer> {
  if (!auth) return { kind: "guest" };
  const { user, session } = auth;
  if (user.kind === "STAFF") return { kind: "staff", user, session };

  let membership: BuyerMembership | null = null;
  if (session.activeAccountId) {
    membership = await db.accountMember.findFirst({
      where: { accountId: session.activeAccountId, userId: user.id, status: MemberStatus.ACTIVE },
      include: { account: true },
    });
  }
  membership ??= await db.accountMember.findFirst({
    where: { userId: user.id, status: MemberStatus.ACTIVE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { account: true },
  });
  return { kind: "customer", user, session, membership };
}

/** The account id a purchase is made for: a member holding `purchases`, else null. */
export function purchasingAccountId(buyer: CheckoutBuyer): string | null {
  if (buyer.kind !== "customer" || !buyer.membership) return null;
  return teamCan(buyer.membership.role, "purchases") ? buyer.membership.accountId : null;
}

/** The signed-in user's id, or null for guests. */
export function buyerUserId(buyer: CheckoutBuyer): string | null {
  return buyer.kind === "guest" ? null : buyer.user.id;
}
