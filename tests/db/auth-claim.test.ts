import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimGuestOrders, claimGuestOrdersSafely } from "@/lib/auth/flows/claim-guest-orders";
import { db } from "@/lib/db";
import { makeOrder, makeUser, testCatalog, uniqueEmail } from "./auth-fixtures";

const claim = (user: Parameters<typeof claimGuestOrders>[1]) => db.$transaction((tx) => claimGuestOrders(tx, user));

describe("claimGuestOrders", () => {
  it("moves the email's guest orders and their licenses to the account the user owns", async () => {
    const { user, accountId } = await makeUser();
    const a = await makeOrder(user.email, { withLicense: true });
    const b = await makeOrder(user.email, { withLicense: true });
    const result = await claim(user);
    expect(result.accountId).toBe(accountId);
    expect(result.orderIds).toEqual([a.order.id, b.order.id].sort());
    expect(result.licenseIds).toEqual([a.licenseId, b.licenseId].sort());
    const licenses = await db.license.findMany({ where: { id: { in: [a.licenseId ?? "", b.licenseId ?? ""] } } });
    expect(licenses.every((l) => l.accountId === accountId)).toBe(true);
  });

  it("never touches other emails, or orders that already belong to an account", async () => {
    const { user } = await makeUser();
    const other = await makeUser();
    const theirs = await makeOrder(user.email, { accountId: other.accountId, withLicense: true });
    const stranger = await makeOrder(uniqueEmail("stranger"), { withLicense: true });
    const result = await claim(user);
    expect(result.orderIds).toEqual([]);
    expect((await db.order.findUniqueOrThrow({ where: { id: theirs.order.id } })).accountId).toBe(other.accountId);
    expect((await db.order.findUniqueOrThrow({ where: { id: stranger.order.id } })).accountId).toBeNull();
  });

  it("is idempotent", async () => {
    const { user } = await makeUser();
    await makeOrder(user.email, { withLicense: true });
    expect((await claim(user)).orderIds).toHaveLength(1);
    expect(await claim(user)).toMatchObject({ orderIds: [], licenseIds: [] });
  });

  it("heals a license issued with no account for an order the account already claimed", async () => {
    const { user, accountId } = await makeUser();
    const { order } = await makeOrder(user.email, { accountId });
    const { product, plan } = await testCatalog();
    const orphan = await db.license.create({
      data: {
        id: `LIC-T${randomBytes(4).toString("hex").toUpperCase()}`,
        productId: product.id,
        planId: plan.id,
        orderId: order.id,
        keyHash: randomBytes(32).toString("hex"),
        keyCiphertext: "v1.a.b.c",
        keyLast4: "ABCD",
        updatesUntil: new Date("2027-10-01T00:00:00.000Z"),
        deviceLimit: 1,
        resetsYear: 2026,
      },
    });
    const result = await claim(user);
    expect(result.licenseIds).toEqual([orphan.id]);
    expect((await db.license.findUniqueOrThrow({ where: { id: orphan.id } })).accountId).toBe(accountId);
  });

  it("does nothing for unverified users, staff, or users who own no account", async () => {
    const unverified = await makeUser({ verified: false });
    const staff = await makeUser({ kind: "STAFF" });
    const member = await makeUser();
    await db.accountMember.updateMany({ where: { userId: member.user.id }, data: { role: "TECHNICAL" } });
    for (const { user } of [unverified, staff, member]) {
      const guest = await makeOrder(user.email);
      expect(await claim(user)).toEqual({ accountId: null, orderIds: [], licenseIds: [] });
      expect((await db.order.findUniqueOrThrow({ where: { id: guest.order.id } })).accountId).toBeNull();
    }
  });

  it("waits for a payment transaction holding the order and still claims the license it issued", async () => {
    const { user, accountId } = await makeUser();
    const { order } = await makeOrder(user.email);
    const { product, plan } = await testCatalog();
    const licenseId = `LIC-T${randomBytes(4).toString("hex").toUpperCase()}`;

    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // Simulates the webhook: lock the order row, read accountId (null), issue a license with it, commit later.
    const webhook = db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ accountId: string | null }[]>`SELECT "accountId" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
        locked();
        await new Promise((r) => setTimeout(r, 300));
        await tx.license.create({
          data: {
            id: licenseId,
            accountId: rows[0]?.accountId ?? null,
            productId: product.id,
            planId: plan.id,
            orderId: order.id,
            keyHash: randomBytes(32).toString("hex"),
            keyCiphertext: "v1.a.b.c",
            keyLast4: "WXYZ",
            updatesUntil: new Date("2027-10-01T00:00:00.000Z"),
            deviceLimit: 1,
            resetsYear: 2026,
          },
        });
      },
      { timeout: 10_000 },
    );
    await lockTaken;
    const claimed = await claimGuestOrdersSafely(user);
    await webhook;
    expect(claimed.orderIds).toEqual([order.id]);
    expect((await db.license.findUniqueOrThrow({ where: { id: licenseId } })).accountId).toBe(accountId);
  });
});
