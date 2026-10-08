import { beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { assertCanActOnOrder, ORDER_LINK_EXPIRED_MESSAGE, resolveOrderAccessFor } from "@/lib/orders/access";
import { signOrderPayToken, signOrderToken } from "@/lib/orders/token";
import { authOf, makeCustomer, makeStaff, placeOrder, seedCatalog, uniq, type CustomerFixture } from "./checkout-fixtures";

let owner: CustomerFixture;
let guestOrder: Awaited<ReturnType<typeof placeOrder>>;
let accountOrder: Awaited<ReturnType<typeof placeOrder>>;

beforeAll(async () => {
  await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
  guestOrder = await placeOrder(null);
  accountOrder = await placeOrder(owner);
});

async function denied(promise: Promise<unknown>): Promise<[number, string]> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return [(e as ApiError).status, (e as ApiError).code];
}

describe("resolveOrderAccessFor: tokens", () => {
  it("answers 401 to a signed-out request without a token, before any lookup", async () => {
    expect(await denied(resolveOrderAccessFor(guestOrder.orderId, { auth: null }))).toEqual([401, "unauthorized"]);
    expect(await denied(resolveOrderAccessFor("AX-999999999", { auth: null }))).toEqual([401, "unauthorized"]);
  });

  it("grants the order link holder access, purchaser status and actions", async () => {
    const access = await resolveOrderAccessFor(guestOrder.orderId, { auth: null, token: guestOrder.orderToken });
    expect(access).toMatchObject({ viaToken: true, isPurchaser: true, canAct: true });
    expect(access.order.id).toBe(guestOrder.orderId);
  });

  it("treats tampered, foreign and wrong-email tokens like unknown orders (404)", async () => {
    const t = guestOrder.orderToken;
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    const cases = [
      flipped,
      accountOrder.orderToken,
      signOrderToken(guestOrder.orderId, "someone-else@example.test"),
      "garbage",
    ];
    for (const token of cases) {
      expect(await denied(resolveOrderAccessFor(guestOrder.orderId, { auth: null, token }))).toEqual([404, "not_found"]);
    }
    expect(await denied(resolveOrderAccessFor("AX-999999999", { auth: null, token: t }))).toEqual([404, "not_found"]);
    expect(await denied(resolveOrderAccessFor("../etc", { auth: null, token: t }))).toEqual([404, "not_found"]);
  });

  it("answers 403 order_link_expired for a genuine link older than 30 days", async () => {
    const old = signOrderToken(guestOrder.orderId, "priya@sharmamedicals.example", new Date(Date.now() - 31 * 86_400_000));
    const e = await resolveOrderAccessFor(guestOrder.orderId, { auth: null, token: old }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    const apiError = e as ApiError;
    expect([apiError.status, apiError.code, apiError.message]).toEqual([403, "order_link_expired", ORDER_LINK_EXPIRED_MESSAGE]);
  });
});

describe("resolveOrderAccessFor: staff with an order link (admin records D19)", () => {
  it("lets a staff session open a payment link it shares, but never makes it the purchaser or lets it act", async () => {
    const staff = await makeStaff();
    const access = await resolveOrderAccessFor(guestOrder.orderId, { auth: authOf(staff), token: guestOrder.orderToken });
    expect(access).toMatchObject({ viaToken: true, isPurchaser: false, canAct: false, viewer: { staff: true } });
    const e = await denied(Promise.resolve().then(() => assertCanActOnOrder(access)));
    expect(e).toEqual([403, "staff_checkout"]);
  });
});

describe("resolveOrderAccessFor: pay-only links (staff-shared payment links)", () => {
  it("open the order and let the holder pay, but never deliver the one-time key", async () => {
    const pay = signOrderPayToken(guestOrder.orderId, "priya@sharmamedicals.example");
    expect(pay.startsWith("p1.")).toBe(true);
    const access = await resolveOrderAccessFor(guestOrder.orderId, { auth: null, token: pay });
    expect(access).toMatchObject({ viaToken: true, tokenScope: "pay", isPurchaser: false, canAct: true });
    const full = await resolveOrderAccessFor(guestOrder.orderId, { auth: null, token: guestOrder.orderToken });
    expect(full).toMatchObject({ tokenScope: "full", isPurchaser: true });
  });

  it("cannot be turned into a full link, and is bound to the order and its email", async () => {
    const pay = signOrderPayToken(guestOrder.orderId, "priya@sharmamedicals.example");
    const forged = `o1${pay.slice(2)}`;
    const upgraded = `p1${guestOrder.orderToken.slice(2)}`;
    for (const token of [forged, upgraded, signOrderPayToken(guestOrder.orderId, "someone-else@example.test"), signOrderPayToken(accountOrder.orderId, "priya@sharmamedicals.example")]) {
      expect(await denied(resolveOrderAccessFor(guestOrder.orderId, { auth: null, token }))).toEqual([404, "not_found"]);
    }
  });
});

describe("resolveOrderAccessFor: sessions", () => {
  it("never lets another account read or act on an order (IDOR)", async () => {
    const stranger = await makeCustomer({ role: "OWNER" });
    expect(await denied(resolveOrderAccessFor(accountOrder.orderId, { auth: authOf(stranger) }))).toEqual([404, "not_found"]);
    expect(await denied(resolveOrderAccessFor(guestOrder.orderId, { auth: authOf(stranger) }))).toEqual([404, "not_found"]);
    const staff = await makeStaff();
    expect(await denied(resolveOrderAccessFor(accountOrder.orderId, { auth: staff }))).toEqual([404, "not_found"]);
  });

  it("lets account members view by role, and act only with purchases", async () => {
    const placer = await resolveOrderAccessFor(accountOrder.orderId, { auth: authOf(owner) });
    expect(placer).toMatchObject({ viaToken: false, isPurchaser: true, canAct: true, viewer: { role: "OWNER" } });

    const viewer = await makeCustomer({ role: "VIEWER", accountId: owner.accountId });
    const v = await resolveOrderAccessFor(accountOrder.orderId, { auth: authOf(viewer) });
    expect(v).toMatchObject({ isPurchaser: false, canAct: false });
    expect(() => assertCanActOnOrder(v)).toThrow(ApiError);

    const billing = await makeCustomer({ role: "BILLING", accountId: owner.accountId });
    expect(await resolveOrderAccessFor(accountOrder.orderId, { auth: authOf(billing) })).toMatchObject({
      isPurchaser: false,
      canAct: true,
    });
  });

  it("drops access when the placer leaves the account", async () => {
    const leaver = await makeCustomer({ role: "BILLING", accountId: owner.accountId });
    const order = await placeOrder(leaver);
    await db.accountMember.deleteMany({ where: { userId: leaver.user.id } });
    expect(await denied(resolveOrderAccessFor(order.orderId, { auth: authOf(leaver) }))).toEqual([404, "not_found"]);
  });

  it("lets the placer of an account-less order in, and nobody else", async () => {
    const user = await db.user.create({ data: { kind: "CUSTOMER", email: `${uniq("solo")}@example.test`, name: "Solo" } });
    const { session } = await createSession(db, { userId: user.id, kind: "CUSTOMER" });
    const order = await placeOrder({ user, session });
    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect([row.accountId, row.placedByUserId]).toEqual([null, user.id]);
    expect(await resolveOrderAccessFor(order.orderId, { auth: { user, session } })).toMatchObject({ isPurchaser: true, canAct: true });
    expect(await denied(resolveOrderAccessFor(order.orderId, { auth: authOf(owner) }))).toEqual([404, "not_found"]);
  });

  it("treats the verified owner of a claimed guest order's email as the purchaser", async () => {
    const email = `${uniq("claim")}@example.test`;
    const order = await placeOrder(null, { email });
    const claimer = await makeCustomer({ role: "OWNER", email });
    await db.order.update({ where: { id: order.orderId }, data: { accountId: claimer.accountId } });
    expect(await resolveOrderAccessFor(order.orderId, { auth: authOf(claimer) })).toMatchObject({ isPurchaser: true, canAct: true });
    const teammate = await makeCustomer({ role: "OWNER", accountId: claimer.accountId });
    expect(await resolveOrderAccessFor(order.orderId, { auth: authOf(teammate) })).toMatchObject({ isPurchaser: false, canAct: true });
  });
});
