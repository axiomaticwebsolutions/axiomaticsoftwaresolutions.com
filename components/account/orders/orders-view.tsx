"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { DataTable, DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError } from "@/lib/client/api";
import { isListFiltered } from "@/lib/url-state";
import { ORDERS_PAGE_SIZE } from "@/lib/validation/portal";
import { downloadFile } from "./download";
import { ORDER_COLUMNS, orderCard } from "./order-cells";
import {
  exportResult,
  exportToastMessage,
  ORDER_STATUS_OPTIONS,
  ORDERS_COPY,
  ORDERS_CSV_FALLBACK_NAME,
  ORDERS_LIST,
  orderHref,
  ordersExportHref,
  type AccountOrderList,
  type AccountOrderRow,
} from "./orders-model";

export type OrdersViewProps = {
  /** One page of orders for the URL state, or null when loading failed. */
  data: AccountOrderList | null;
  description: string;
};

const getRowId = (row: AccountOrderRow) => row.id;
/** Rows open the order page on click (mouse convenience; the order id is the real link). */
const rowClassName = () => "cursor-pointer hover:bg-lavender-soft/50";
/** Clicks on these inside a row do their own thing. */
const INTERACTIVE = "a,button,input,select,textarea,label,summary,[role='button'],[role='link']";

/** The order id of the table row a click landed on, unless it hit a control or ended a text selection. */
function clickedOrderId(event: React.MouseEvent<HTMLElement>): string | null {
  const target = event.target as HTMLElement;
  const tr = target.closest<HTMLElement>("tbody tr[data-row-id]");
  if (!tr || !event.currentTarget.contains(tr)) return null;
  const hit = target.closest(INTERACTIVE);
  if (hit && tr.contains(hit)) return null;
  if (window.getSelection()?.toString()) return null;
  return tr.dataset.rowId ?? null;
}

/** Orders & invoices (Customer Portal.dc.html "Orders"): server-paged, URL-synced table and the accountant CSV. */
export function OrdersView({ data, description }: OrdersViewProps) {
  const router = useRouter();
  const list = useListState(ORDERS_LIST);
  const [exporting, setExporting] = React.useState(false);
  const total = data?.total ?? 0;
  const filtered = isListFiltered(list.applied, ORDERS_LIST);

  const exportOrders = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { fileName, headers } = await downloadFile(ordersExportHref(list.applied), ORDERS_CSV_FALLBACK_NAME);
      const result = exportResult(headers);
      toast.success(exportToastMessage(result.rows ?? total, fileName, result.truncated));
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : ORDERS_COPY.exportFailed);
    } finally {
      setExporting(false);
    }
  };

  // Rows open the order page with a full page load (its CSP differs: decisions.md Phase 3 integration).
  const openRow = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const id = clickedOrderId(event);
    if (!id) return;
    const href = orderHref({ id });
    if (event.metaKey || event.ctrlKey) window.open(href, "_blank", "noopener");
    else window.location.assign(href);
  };
  const openRowInNewTab = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    const id = clickedOrderId(event);
    if (id) window.open(orderHref({ id }), "_blank", "noopener");
  };

  let emptyState: React.ReactNode;
  if (filtered) {
    emptyState = (
      <DataTableEmptyState action={<EmptyStateAction clearsFilters onClick={list.clear}>{ORDERS_COPY.clearFilters}</EmptyStateAction>}>
        {ORDERS_COPY.empty}
      </DataTableEmptyState>
    );
  } else {
    emptyState = (
      <DataTableEmptyState
        action={
          <Link href={PORTAL_PATHS.catalog} className="rounded-6 font-bold text-primary-link hover:text-primary-link-hover hover:underline">
            {ORDERS_COPY.browse}
          </Link>
        }
      >
        {ORDERS_COPY.emptyNone}
      </DataTableEmptyState>
    );
  }

  return (
    <>
      <PageHeader
        title={ORDERS_COPY.title}
        description={description}
        actions={
          <PageAction icon={exporting ? undefined : "download"} perm="invoices.view" onClick={exportOrders} busy={exporting}>
            {/* 18px slot like the icon, so the label does not move while the file is prepared. */}
            {exporting ? (
              <span className="inline-grid size-[18px] place-items-center">
                <Spinner size="sm" tone="current" />
              </span>
            ) : null}
            {ORDERS_COPY.exportAction}
          </PageAction>
        }
      />
      {/* Mouse convenience only: every row also has its order id link and an Invoice/View control for keyboards. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div onClick={openRow} onAuxClick={openRowInNewTab} className="min-w-0 animate-enter-up motion-reduce:animate-none">
        <DataTable
          caption={ORDERS_COPY.caption}
          columns={ORDER_COLUMNS}
          data={data?.orders ?? []}
          getRowId={getRowId}
          sorting={list.sorting}
          onSortingChange={list.onSortingChange}
          sortDescFirst
          minWidth={820}
          loading={list.isPending}
          rowClassName={rowClassName}
          mobileCard={orderCard}
          toolbar={{
            search: {
              value: list.state.q,
              onChange: list.setQuery,
              placeholder: ORDERS_COPY.searchPlaceholder,
              label: ORDERS_COPY.searchLabel,
            },
            filters: [
              {
                id: "status",
                label: ORDERS_COPY.statusLabel,
                options: ORDER_STATUS_OPTIONS,
                value: list.state.filters.status,
                onChange: (value) => list.setFilter("status", value),
              },
            ],
            onClear: list.clear,
          }}
          pagination={{
            page: list.applied.page,
            pageSize: ORDERS_PAGE_SIZE,
            total,
            onPageChange: list.setPage,
            pageHref: list.pageHref,
            label: ORDERS_COPY.paginationLabel,
            emptyLabel: ORDERS_COPY.emptyLabel,
          }}
          emptyState={emptyState}
          errorState={
            data ? undefined : (
              <DataTableEmptyState
                tone="error"
                icon="error"
                action={<EmptyStateAction onClick={() => router.refresh()}>{ORDERS_COPY.retry}</EmptyStateAction>}
              >
                {ORDERS_COPY.loadError}
              </DataTableEmptyState>
            )
          }
        />
      </div>
    </>
  );
}
