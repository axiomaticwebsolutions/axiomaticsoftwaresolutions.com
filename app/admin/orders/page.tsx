/**
 * /admin/orders: Orders, payments & refunds (Admin Console.dc.html #orders; decisions.md Phase 6). Server-rendered page
 * of orders for the URL state (?q=&filter[status]=&sort=-createdAt&page=, 25 per page) through lib/admin/orders (the
 * same query as GET /api/admin/orders), with the stats row and the filter options. The client table writes the URL
 * back and keeps the open drawer in ?id=. orders.view is every staff role; the module page still checks it first.
 */
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage, type AdminStat } from "@/components/admin/module-page";
import { OrdersView } from "@/components/admin/orders/orders-view";
import { getAdminState } from "@/lib/admin/context";
import { adminOrderFilterOptions, adminOrderStats, listAdminOrders } from "@/lib/admin/orders/list";
import {
  ADMIN_ORDERS_LIST,
  moneyRounded,
  orderQueryFromState,
  type AdminOrderFilterOptions,
  type AdminOrderList,
  type AdminOrderStats,
} from "@/lib/admin/orders/model";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { parseListState } from "@/lib/url-state";

export const metadata = adminPageMetadata("orders");

type AdminOrdersPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NO_OPTIONS: AdminOrderFilterOptions = { products: [], coupons: [], providers: [] };
const count = (n: number) => n.toLocaleString("en-IN");

function statsOf(stats: AdminOrderStats): AdminStat[] {
  return [
    { label: "Paid (all time)", value: count(stats.paid), tone: "sage" },
    { label: "Pending", value: count(stats.pending), tone: "peach" },
    { label: "Failed", value: count(stats.failed), tone: "pink" },
    { label: "Refunded", value: moneyRounded(stats.refundedPaise), tone: "lavender" },
  ];
}

export default async function AdminOrdersPage({ searchParams }: AdminOrdersPageProps) {
  const state = await getAdminState();
  // Locked or inactive: the module page renders the denied page (or nothing) and no order data is loaded.
  if (state.kind !== "ready" || !state.context.canView("orders")) return <AdminModulePage moduleKey="orders" />;

  const listState = parseListState(await searchParams, ADMIN_ORDERS_LIST);
  let list: AdminOrderList | null = null;
  let stats: AdminOrderStats | null = null;
  let options = NO_OPTIONS;
  try {
    [list, stats, options] = await Promise.all([
      listAdminOrders(db, orderQueryFromState(listState)),
      adminOrderStats(db),
      adminOrderFilterOptions(db),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("admin_orders_unavailable", { error: error instanceof Error ? error.name : "unknown" });
  }

  return (
    <AdminModulePage moduleKey="orders" stats={stats ? statsOf(stats) : undefined} statsLabel="Order totals">
      <Suspense>
        <OrdersView list={list} options={options} />
      </Suspense>
    </AdminModulePage>
  );
}
