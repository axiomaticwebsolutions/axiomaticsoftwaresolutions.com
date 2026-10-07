/**
 * Security entries in the customer's account activity log (portal "Activity log", kind "security"), with the
 * prototype's wording: "Changed password" / "Other sessions signed out", "Signed out session" / "{device}",
 * "Signed out all other sessions". Written to the session's active account (else the user's first ACTIVE
 * membership). Staff have no business account, so nothing is written for them. Entries record the actor (actorId).
 */
import "server-only";
import type { Session, User } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

export async function activeAccountIdFor(client: Db, user: Pick<User, "id" | "kind">, session: Pick<Session, "activeAccountId">): Promise<string | null> {
  if (user.kind !== "CUSTOMER") return null;
  if (session.activeAccountId) {
    const chosen = await client.accountMember.findFirst({
      where: { accountId: session.activeAccountId, userId: user.id, status: "ACTIVE" },
      select: { accountId: true },
    });
    if (chosen) return chosen.accountId;
  }
  const first = await client.accountMember.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { accountId: true },
  });
  return first?.accountId ?? null;
}

export async function recordSecurityActivity(
  client: Db,
  auth: { user: Pick<User, "id" | "kind" | "name">; session: Pick<Session, "activeAccountId"> },
  entry: { action: string; target: string; now: Date },
): Promise<void> {
  const accountId = await activeAccountIdFor(client, auth.user, auth.session);
  if (!accountId) return;
  await client.accountActivity.create({
    data: {
      accountId,
      actorId: auth.user.id,
      actorName: auth.user.name,
      action: entry.action,
      target: entry.target.slice(0, 200),
      kind: "security",
      createdAt: entry.now,
    },
  });
}
