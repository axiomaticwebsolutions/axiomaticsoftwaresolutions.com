/**
 * /account/orders: Orders & invoices (Customer Portal.dc.html "Orders"; decisions.md Phase 5 "Orders").
 * Server-rendered page of the active account's orders for the URL state (?q=&status=&sort=&page=, 8 per page) through
 * lib/portal/orders (the same query as GET /api/account/orders); the client table writes the URL back. Every team role
 * holds invoices.view. The account id always comes from the session (getPortalContext), never from the URL.
 */
import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { PageHeader } from "@/components/account/page-header";
import { PermissionDenied } from "@/components/account/permission-denied";
import { OrdersView } from "@/components/account/orders/orders-view";
import { ORDERS_COPY, ORDERS_LIST, orderListQuery, ordersDescription } from "@/components/account/orders/orders-model";
import { ownAccountId } from "@/lib/auth/flows/common";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { getPortalContext } from "@/lib/portal/context";
import { listAccountOrders, type AccountOrderList } from "@/lib/portal/orders";
import { parseListState } from "@/lib/url-state";

export const metadata: Metadata = { title: ORDERS_COPY.title };

type OrdersPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const portal = await getPortalContext();
  if (!portal.can("invoices.view")) {
    return (
      <>
        <PageHeader title={ORDERS_COPY.title} />
        <PermissionDenied area={ORDERS_COPY.title} perm="invoices.view" role={portal.role} />
      </>
    );
  }
  const state = parseListState(await searchParams, ORDERS_LIST);
  let data: AccountOrderList | null = null;
  let guestCheckoutEmail: string | null = null;
  try {
    const [orders, claimAccountId] = await Promise.all([
      listAccountOrders(db, portal.account.id, orderListQuery(state)),
      // Guest checkouts with the member's email are claimed into the account they created themselves, never one they
      // joined by invitation (decisions.md rule 1).
      ownAccountId(db, portal.user.id),
    ]);
    data = orders;
    if (claimAccountId === portal.account.id) guestCheckoutEmail = portal.user.email;
  } catch (error) {
    unstable_rethrow(error);
    log.warn("portal_orders_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return <OrdersView data={data} description={ordersDescription(guestCheckoutEmail)} />;
}
