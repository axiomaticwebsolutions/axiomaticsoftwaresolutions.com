"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/sonner";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { usePortal } from "@/components/account/portal-context";
import { teamRequiresLabel } from "@/components/account/portal-nav";
import {
  BulkAction,
  DataTable,
  DataTableEmptyState,
  EmptyStateAction,
  clampPage,
  pruneSelection,
  sliceForPage,
  useListState,
} from "@/components/data-table";
import { csvFileName, downloadCsv, toCsv } from "@/lib/csv";
import { addLicenseLines, CART_FAILED_MESSAGE, CART_FULL_MESSAGE, CART_PATH, toastAfterNavigation } from "./cart";
import type { LicenseListData } from "./data";
import { licenseCard, licenseColumns } from "./licenses-columns";
import {
  LICENSE_CSV_COLUMNS,
  LICENSES_CSV_FILE,
  LICENSES_LIST,
  LICENSES_PAGE_SIZE,
  filterLicenses,
  licenseHref,
  licenseProductOptions,
  licenseStatusOptions,
  licensesFooter,
  renewalSelection,
  sortLicenses,
  type LicenseListRow,
} from "./model";

function exportLicenses(rows: readonly LicenseListRow[]) {
  downloadCsv(LICENSES_CSV_FILE, toCsv(rows, LICENSE_CSV_COLUMNS));
  const n = rows.length;
  toast.success(`Exported ${n.toLocaleString("en-IN")} ${n === 1 ? "row" : "rows"} to ${csvFileName(LICENSES_CSV_FILE)}`);
}

const rowHref = (row: LicenseListRow) => licenseHref(row.id);

/** /account/licenses (Customer Portal prototype "Licenses"): every license of the business, filtered in the browser. */
export function LicensesView({ data }: { data: LicenseListData }) {
  const router = useRouter();
  const { can } = usePortal();
  const canBuy = can("purchases");
  const list = useListState(LICENSES_LIST, { mode: "client" });
  const { q, filters, sort, page } = list.state;
  const now = React.useMemo(() => new Date(data.now), [data.now]);
  const columns = React.useMemo(() => licenseColumns(now), [now]);
  const rows = React.useMemo(
    () => sortLicenses(filterLicenses(data.rows, { q, status: filters.status, product: filters.product }), sort),
    [data.rows, q, filters.status, filters.product, sort],
  );
  const paged = rows.length > LICENSES_PAGE_SIZE;
  const pageRows = React.useMemo(
    () => (paged ? sliceForPage(rows, clampPage(page, rows.length, LICENSES_PAGE_SIZE), LICENSES_PAGE_SIZE) : rows),
    [paged, rows, page],
  );
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const visibleSelected = React.useMemo(() => pruneSelection(selected, rows.map((r) => r.id)), [selected, rows]);

  const selectedRows = () => {
    const ids = new Set(visibleSelected);
    return rows.filter((r) => ids.has(r.id));
  };

  const renewSelected = () => {
    const { lines, skipped } = renewalSelection(rows, visibleSelected);
    if (lines.length === 0) {
      toast.error(skipped > 0 ? "Revoked licenses can’t be renewed. Contact support if you think this is a mistake." : CART_FAILED_MESSAGE);
      return;
    }
    const result = addLicenseLines(lines);
    if (result.added === 0) {
      toast.error(result.full ? CART_FULL_MESSAGE : CART_FAILED_MESSAGE);
      return;
    }
    router.push(CART_PATH);
    if (skipped > 0 || result.failed > 0) toastAfterNavigation(CART_PATH, () => toast("Revoked licenses were skipped"));
  };

  const footer = `${licensesFooter(rows.length, data.total)}${data.truncated ? " · only the first 1,000 are listed" : ""}`;

  return (
    <>
      <PageHeader
        title="Licenses"
        description="Every license your business owns, with status, term and device usage. Select licenses to renew or export them together."
        actions={
          <>
            <PageAction icon="download" onClick={() => exportLicenses(rows)}>
              Export CSV
            </PageAction>
            <PageAction variant="primary" icon="add" href="/software" perm="purchases">
              Buy a license
            </PageAction>
          </>
        }
      />
      <DataTable
        className="animate-enter-up motion-reduce:animate-none"
        caption="Licenses"
        columns={columns}
        data={pageRows}
        getRowId={(r) => r.id}
        manual
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={820}
        // Prototype: with no matching licenses only the message shows (the Devices table keeps its header).
        hideTableWhenEmpty
        rowHref={rowHref}
        mobileCard={licenseCard}
        toolbar={{
          search: { value: q, onChange: list.setQuery, placeholder: "License ID, product or last 4 of key", label: "Search licenses" },
          filters: [
            { id: "status", label: "Status", options: licenseStatusOptions(data.rows), value: filters.status, onChange: (v) => list.setFilter("status", v) },
            { id: "product", label: "Product", options: licenseProductOptions(data.products), value: filters.product, onChange: (v) => list.setFilter("product", v) },
          ],
        }}
        selection={{
          selected: visibleSelected,
          onChange: setSelected,
          bulkActions: (
            <>
              <BulkAction tone="primary" disabledReason={canBuy ? undefined : teamRequiresLabel("purchases")} onClick={renewSelected}>
                Renew selected
              </BulkAction>
              <BulkAction onClick={() => exportLicenses(selectedRows())}>Export selected</BulkAction>
            </>
          ),
        }}
        pagination={
          paged
            ? {
                page,
                pageSize: LICENSES_PAGE_SIZE,
                total: rows.length,
                onPageChange: list.setPage,
                pageHref: list.pageHref,
                label: "License pages",
                rangeLabel: ({ from, to, total }) =>
                  `Showing ${from}–${to} of ${total.toLocaleString("en-IN")} licenses · keys are masked; open a license to reveal`,
              }
            : undefined
        }
        footer={paged ? undefined : footer}
        emptyState={
          data.rows.length === 0 ? (
            <DataTableEmptyState title="No licenses yet">
              Buy a license or start a free trial to see it here.{" "}
              <Link href="/software" className="rounded-6 font-bold text-primary-link hover:text-primary-link-hover">
                Browse software
              </Link>
            </DataTableEmptyState>
          ) : (
            <DataTableEmptyState
              action={
                <EmptyStateAction clearsFilters onClick={list.clear}>
                  Clear filters
                </EmptyStateAction>
              }
            >
              No licenses match these filters.
            </DataTableEmptyState>
          )
        }
      />
    </>
  );
}
