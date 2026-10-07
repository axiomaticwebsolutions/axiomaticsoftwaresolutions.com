/**
 * Guest-order claim (docs/decisions.md business rule 1 and Phase 3 "Auth"): orders placed with the user's email and
 * `accountId = null`, and the licenses those orders issued, move to the account the user created and owns
 * (ownAccountId: never an account they joined by invitation, even if they were made Owner there).
 * Runs when the email is verified (inside that transaction) and on every sign-in of a verified customer.
 *
 * Concurrency: the order UPDATE re-checks `accountId IS NULL` under the row lock, so a payment webhook holding the
 * order row (B4 locks it FOR UPDATE) finishes first. Licenses are moved by joining on the account's orders for this
 * email, which also heals a license that a webhook issued with `accountId = null` while the claim was committing.
 */
import "server-only";
import type { User } from "@/generated/prisma/client";
import { normalizeEmail, ownAccountId } from "@/lib/auth/flows/common";
import { db, type Tx } from "@/lib/db";
import { log } from "@/lib/log";

export type ClaimResult = { accountId: string | null; orderIds: string[]; licenseIds: string[] };

type Claimant = Pick<User, "id" | "email" | "kind" | "emailVerifiedAt">;

/** Claims inside the caller's transaction. Only verified customers who own an account of their own claim anything. */
export async function claimGuestOrders(tx: Tx, user: Claimant): Promise<ClaimResult> {
  if (user.kind !== "CUSTOMER" || !user.emailVerifiedAt) return { accountId: null, orderIds: [], licenseIds: [] };
  const accountId = await ownAccountId(tx, user.id);
  if (!accountId) return { accountId: null, orderIds: [], licenseIds: [] };
  const email = normalizeEmail(user.email);

  const orders = await tx.order.updateManyAndReturn({
    where: { email, accountId: null },
    data: { accountId },
    select: { id: true },
  });
  const licenses = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "License" AS l
    SET "accountId" = ${accountId}
    FROM "Order" AS o
    WHERE l."orderId" = o."id"
      AND l."accountId" IS NULL
      AND o."accountId" = ${accountId}
      AND o."email" = ${email}
    RETURNING l."id"`;
  return { accountId, orderIds: orders.map((o) => o.id).sort(), licenseIds: licenses.map((l) => l.id).sort() };
}

/**
 * Claims in its own transaction (sign-in). Never throws: a failed claim must not block signing in, and the next
 * sign-in retries it.
 */
export async function claimGuestOrdersSafely(user: Claimant): Promise<ClaimResult> {
  try {
    const result = await db.$transaction((tx) => claimGuestOrders(tx, user));
    if (result.orderIds.length > 0 || result.licenseIds.length > 0) {
      log.info("guest_orders_claimed", {
        userId: user.id,
        accountId: result.accountId,
        orders: result.orderIds,
        licenses: result.licenseIds.length,
      });
    }
    return result;
  } catch (error) {
    log.error("guest_orders_claim_failed", { userId: user.id, error });
    return { accountId: null, orderIds: [], licenseIds: [] };
  }
}
