"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { afterDrawerClose } from "@/components/admin/coupons/after-close";
import { exportCsv, exportHref } from "@/components/admin/coupons/export";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import { toast } from "@/components/ui/sonner";
import {
  FAQ_COPY,
  FAQS_LIST,
  filterAndSortFaqs,
  type FaqDto,
  type FaqPageOption,
  type FaqSort,
  type FaqStatus,
} from "@/lib/admin/content/model";
import { apiFetch } from "@/lib/client/api";
import { FAQ_COLUMNS, faqCard } from "./faq-columns";
import { FaqDrawer } from "./faq-drawer";
import { NEW_FAQ_PARAM, NewFaqDrawer } from "./new-faq";

type Props = { faqs: FaqDto[]; pages: FaqPageOption[] };

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
];

/**
 * FAQ table (Admin Console.dc.html #content): search, Page and Status filters, sortable Question / Page / Position,
 * bulk Publish and Unpublish, server CSV, the row drawer (?id=) and the "New FAQ" drawer (?new=1).
 */
export function FaqsView({ faqs, pages }: Props) {
  const router = useRouter();
  const list = useListState(FAQS_LIST, { mode: "client" });
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_FAQ_PARAM);
  const [refreshing, startRefresh] = React.useTransition();
  const refresh = React.useCallback(() => startRefresh(() => router.refresh()), [router]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = React.useState<boolean | null>(null);

  const pageFilter = list.state.filters.page;
  const status = list.state.filters.status;
  const rows = React.useMemo(
    () =>
      filterAndSortFaqs(
        faqs,
        {
          q: list.state.q,
          filters: { page: pageFilter === "all" ? undefined : pageFilter, status: status === "all" ? undefined : (status as FaqStatus) },
          sort: (list.state.sort ?? { id: "order", desc: false }) as { id: FaqSort; desc: boolean },
        },
        pages,
      ),
    [faqs, pages, list.state.q, list.state.sort, pageFilter, status],
  );
  const pageSize = list.state.pageSize;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(list.state.page, pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const current = drawer.id ? (faqs.find((f) => f.id === drawer.id) ?? null) : null;
  const pageOptions = [{ value: "all", label: "All" }, ...pages.map((p) => ({ value: p.value, label: p.label }))];

  async function bulk(published: boolean) {
    setBulkBusy(published);
    try {
      const { updated } = await apiFetch<{ updated: number }>("/api/admin/faqs/bulk", { method: "POST", body: { ids: selected, published } });
      toast.success(updated === 0 ? FAQ_COPY.noChanges : published ? FAQ_COPY.published : FAQ_COPY.unpublished);
      setSelected([]);
      refresh();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBulkBusy(null);
    }
  }

  return (
    <>
      <AdminTable
        caption={FAQ_COPY.caption}
        columns={FAQ_COLUMNS}
        data={pageRows}
        getRowId={(f) => f.id}
        getRowLabel={(f) => f.question}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={refreshing}
        minWidth={680}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: FAQ_COPY.searchPlaceholder, label: FAQ_COPY.searchLabel },
          filters: [
            { id: "page", label: "Page", options: pageOptions, value: pageFilter, onChange: (v) => list.setFilter("page", v) },
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: status, onChange: (v) => list.setFilter("status", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "faqs.csv", onExport: () => exportCsv(exportHref("/api/admin/faqs/export.csv", list.state, FAQS_LIST), "faqs.csv") },
        }}
        exportPerm={["reports.export", "content.manage"]}
        resultCount={rows.length}
        pagination={{ page, pageSize, total: rows.length, onPageChange: list.setPage, pageHref: list.pageHref }}
        selection={{
          selected,
          onChange: setSelected,
          bulkActions: (
            <>
              <AdminBulkAction perm="content.manage" loading={bulkBusy === true} onClick={() => void bulk(true)}>
                Publish
              </AdminBulkAction>
              <AdminBulkAction perm="content.manage" loading={bulkBusy === false} onClick={() => void bulk(false)}>
                Unpublish
              </AdminBulkAction>
            </>
          ),
        }}
        onRowClick={(f) => drawer.open(f.id)}
        mobileCard={faqCard}
        emptyMessage="No FAQs yet. Add one with “New FAQ”."
      />
      <FaqDrawer open={drawer.isOpen} onOpenChange={drawer.onOpenChange} faq={current} pages={pages} onChanged={refresh} onDeleted={() => afterDrawerClose(drawer.close, refresh)} />
      <NewFaqDrawer
        open={create.isOpen && !drawer.isOpen}
        onOpenChange={create.onOpenChange}
        pages={pages}
        defaultPage={pageFilter !== "all" && pages.some((p) => p.value === pageFilter) ? pageFilter : "home"}
      />
    </>
  );
}
