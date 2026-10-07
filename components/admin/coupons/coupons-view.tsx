"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import {
  COUPON_COPY,
  COUPON_STATUS_LABELS,
  COUPON_STATUSES,
  COUPONS_LIST,
  filterAndSortCoupons,
  normalizeCouponCode,
  type CouponDto,
  type CouponSort,
  type CouponStatus,
} from "@/lib/admin/coupons/model";
import { afterDrawerClose } from "./after-close";
import { COUPON_COLUMNS, couponCard } from "./coupon-columns";
import { CouponDrawer } from "./coupon-drawer";
import type { CouponProductOption } from "./coupon-form";
import { exportCsv, exportHref } from "./export";
import { NEW_PARAM, NewCouponDrawer } from "./new-coupon";

type Props = {
  coupons: CouponDto[];
  products: CouponProductOption[];
  /** Today's IST date ("2026-10-07") from the server, for new coupons' default dates. */
  today: string;
};

const STATUS_OPTIONS = [{ value: "all", label: "All" }, ...COUPON_STATUSES.map((s) => ({ value: s, label: COUPON_STATUS_LABELS[s] }))];

/**
 * Coupons table (Admin Console.dc.html #coupons): search, Status filter, sortable Code / Status / Usage / Valid,
 * server CSV export (reports.export), row drawer (?id=CODE) and the "New coupon" drawer (?new=1). The table is small
 * and staff-made, so the page sends every coupon and the list state (in the URL) is applied here.
 */
export function CouponsView({ coupons, products, today }: Props) {
  const router = useRouter();
  const list = useListState(COUPONS_LIST, { mode: "client" });
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_PARAM);
  const [refreshing, startRefresh] = React.useTransition();
  const refresh = React.useCallback(() => startRefresh(() => router.refresh()), [router]);

  const status = list.state.filters.status;
  const rows = React.useMemo(
    () =>
      filterAndSortCoupons(coupons, {
        q: list.state.q,
        filters: { status: status === "all" ? undefined : (status as CouponStatus) },
        sort: (list.state.sort ?? { id: "starts", desc: true }) as { id: CouponSort; desc: boolean },
      }),
    [coupons, list.state.q, list.state.sort, status],
  );
  const pageSize = list.state.pageSize;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(list.state.page, pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const code = drawer.id ? normalizeCouponCode(drawer.id) : null;
  const selected = code ? (coupons.find((c) => c.code === code) ?? null) : null;

  return (
    <>
      <AdminTable
        caption={COUPON_COPY.caption}
        columns={COUPON_COLUMNS}
        data={pageRows}
        getRowId={(c) => c.code}
        getRowLabel={(c) => c.code}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={refreshing}
        minWidth={820}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: COUPON_COPY.searchPlaceholder, label: COUPON_COPY.searchLabel },
          filters: [{ id: "status", label: "Status", options: STATUS_OPTIONS, value: status, onChange: (v) => list.setFilter("status", v) }],
          onClear: list.clear,
          csv: { fileName: "coupons.csv", onExport: () => exportCsv(exportHref("/api/admin/coupons/export.csv", list.state, COUPONS_LIST), "coupons.csv") },
        }}
        exportPerm="reports.export"
        resultCount={rows.length}
        pagination={{ page, pageSize, total: rows.length, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(c) => drawer.open(c.code)}
        mobileCard={couponCard}
        emptyMessage="No coupons yet. Create one with “New coupon”."
      />
      <CouponDrawer
        open={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
        code={code}
        coupon={selected}
        products={products}
        today={today}
        onChanged={refresh}
        onDeleted={() => afterDrawerClose(drawer.close, refresh)}
      />
      <NewCouponDrawer open={create.isOpen && !drawer.isOpen} onOpenChange={create.onOpenChange} products={products} today={today} />
    </>
  );
}
