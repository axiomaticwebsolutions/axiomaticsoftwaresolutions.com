/**
 * Who may see and act on an order (docs/decisions.md Phase 3 "Order access"). Authorization is decided on the server
 * from the session and the order link token only; ids from the client are never trusted for ownership.
 *
 * Access is granted to:
 * - a signed-in ACTIVE member of the order's account whose team role has `invoices.view`;
 * - the signed-in user who placed an order that has no account (a customer without a business account);
 * - the holder of a valid order link token (`?t=`, lib/orders/token.ts) bound to the order id and email.
 *
 * Answers: 401 when signed out without a token (checked before any lookup); 403 `order_link_expired` for a genuine
 * but expired link; otherwise 404 "Order not found." for unknown orders, bad tokens and orders the viewer may not
 * see, so order ids cannot be probed.
 *
 * isPurchaser (one-time key delivery): the holder of a full order link, the user who placed the order, or, for a guest
 * order that was claimed into an account, the verified owner of the order email. Never a staff session (admin records
 * D19) and never a pay-only link (lib/orders/token.ts "p1", the payment links staff copy and share): a staff member
 * opening a payment link they shared must not see, or use up, the customer's one-time key view. canAct (pay, retry,
 * cancel): the link holder (full or pay-only), the placer of an account-less order, or a member whose role has
 * `purchases`; never a staff session (staff cannot accept the terms or pay on a customer's behalf, D11).
 */
import { MemberStatus, type Order, type Session, type TeamRole, type User } from "@/generated/prisma/client";
import { db as defaultDb, type Db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { teamCan } from "@/lib/rbac";
import { PURCHASE_FORBIDDEN_MESSAGE, STAFF_CHECKOUT_MESSAGE } from "@/lib/checkout/buyer";
import { isOrderIdShape } from "@/lib/validation/checkout";
import { inspectOrderToken, type OrderTokenScope } from "./token";

export const ORDER_LINK_EXPIRED_MESSAGE =
  "This order link has expired. Sign in with the email you used for the order, or contact support.";

export type OrderViewer = { user: User; session: Session } | null;

export type OrderAccess = {
  order: Order;
  /** Access came from a valid order link token. */
  viaToken: boolean;
  /** Scope of that token: "full" (order link) or "pay" (staff-shared payment link); null without one. */
  tokenScope: OrderTokenScope | null;
  /** Receives the full license key once (decisions.md 10). */
  isPurchaser: boolean;
  /** May start, retry or cancel payments and report the payment return. */
  canAct: boolean;
  viewer: { userId: string | null; name: string | null; role: TeamRole | null; staff: boolean };
};

export type ResolveOrderAccessOptions = { token?: string | null; auth: OrderViewer; now?: Date; db?: Db };

/** Access for an explicit viewer (route handlers pass getCurrentAuth(); tests pass a resolved session or null). */
export async function resolveOrderAccessFor(orderId: string, opts: ResolveOrderAccessOptions): Promise<OrderAccess> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const auth = opts.auth;
  const token = typeof opts.token === "string" && opts.token.trim() !== "" ? opts.token.trim() : null;
  if (!isOrderIdShape(orderId)) throw errors.notFound("Order");
  if (!auth && !token) throw errors.unauthorized();

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw errors.notFound("Order");

  let tokenState: "none" | "valid" | "expired" | "invalid" = "none";
  let tokenScope: OrderTokenScope | null = null;
  if (token) {
    const result = inspectOrderToken(token, order.id, now, { email: order.email });
    tokenState = result.ok ? "valid" : result.reason === "expired" ? "expired" : "invalid";
    if (result.ok) tokenScope = result.payload.scope;
  }

  let role: TeamRole | null = null;
  if (auth && auth.user.kind === "CUSTOMER" && order.accountId) {
    const membership = await db.accountMember.findFirst({
      where: { accountId: order.accountId, userId: auth.user.id, status: MemberStatus.ACTIVE },
      select: { role: true },
    });
    role = membership?.role ?? null;
  }

  const viaToken = tokenState === "valid";
  const memberCanView = teamCan(role, "invoices.view");
  const placedByViewer = auth !== null && order.placedByUserId !== null && order.placedByUserId === auth.user.id;
  const ownAccountlessOrder = placedByViewer && order.accountId === null;

  if (!viaToken && !memberCanView && !ownAccountlessOrder) {
    if (tokenState === "expired") throw new ApiError(403, "order_link_expired", ORDER_LINK_EXPIRED_MESSAGE);
    throw errors.notFound("Order");
  }

  const claimedByEmailOwner =
    auth !== null &&
    memberCanView &&
    order.placedByUserId === null &&
    auth.user.emailVerifiedAt !== null &&
    auth.user.email === order.email;

  const staffViewer = auth !== null && auth.user.kind === "STAFF";
  const viaFullToken = viaToken && tokenScope === "full";
  return {
    order,
    viaToken,
    tokenScope: viaToken ? tokenScope : null,
    isPurchaser: !staffViewer && (viaFullToken || (placedByViewer && (memberCanView || ownAccountlessOrder)) || claimedByEmailOwner),
    canAct: !staffViewer && (viaToken || ownAccountlessOrder || teamCan(role, "purchases")),
    viewer: { userId: auth?.user.id ?? null, name: auth?.user.name ?? null, role, staff: staffViewer },
  };
}

/**
 * Access for the current request's session (cookies) and an optional order link token. Throws ApiError 401/403/404.
 * Route handlers and server components call this; it never trusts an account id from the client.
 */
export async function resolveOrderAccess(orderId: string, opts: { token?: string | null } = {}): Promise<OrderAccess> {
  // Loaded lazily so this module stays usable outside a Next request (scripts, DB tests).
  const { getCurrentAuth } = await import("@/lib/auth/guards");
  const auth = await getCurrentAuth();
  return resolveOrderAccessFor(orderId, { token: opts.token ?? null, auth });
}

/** 403 unless the viewer may pay for, retry or cancel the order (a staff session: 403 `staff_checkout`). */
export function assertCanActOnOrder(access: OrderAccess): void {
  if (access.viewer.staff) throw errors.forbidden(STAFF_CHECKOUT_MESSAGE, "staff_checkout");
  if (!access.canAct) throw errors.forbidden(PURCHASE_FORBIDDEN_MESSAGE);
}
