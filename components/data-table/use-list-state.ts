"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SortingState } from "@tanstack/react-table";
import {
  clearListFilters,
  fromSortingState,
  isListFiltered,
  listStateHref,
  normalizeQuery,
  parseListState,
  sameListState,
  toSortingState,
  updateListState,
  type ListSort,
  type ListState,
  type ListStateConfig,
  type ListStatePatch,
} from "@/lib/url-state";

export type UseListStateOptions = {
  /**
   * "server" (default): the server page renders the rows for the URL; each change navigates with router.replace
   * (or push) inside a transition, and `isPending` is true until the new rows arrive.
   * "client": rows are filtered in the browser from `state`; the URL is only mirrored (history.replaceState, no
   * server round trip) so the view can be shared and survives a reload.
   */
  mode?: "server" | "client";
  /** History entry per change in server mode (default "replace"). */
  history?: "replace" | "push";
  /** Delay before a typed search reaches the URL (default 300 ms). */
  debounceMs?: number;
};

export type ListStateControls<F extends string> = {
  /** State of the controls, updated immediately (q is the raw text in the search box). */
  state: ListState<F>;
  /** State the URL holds (what server-rendered rows reflect). */
  applied: ListState<F>;
  setQuery: (q: string) => void;
  setFilter: (id: F, value: string) => void;
  setSort: (sort: ListSort | null) => void;
  /** TanStack-shaped sorting for <DataTable sorting onSortingChange>. */
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  update: (patch: ListStatePatch<F>) => void;
  /** Clears the search and filters (keeps the sort). */
  clear: () => void;
  /** Link for a page of this list (pagination pageHref). */
  pageHref: (page: number) => string;
  isFiltered: boolean;
  isPending: boolean;
};

/**
 * List state (q, filters, sort, page) kept in the URL for a DataTable. Pass a module-level config (it is a hook
 * dependency). Uses useSearchParams, so a statically rendered page needs a <Suspense> boundary around the table.
 *
 *   const ORDERS_LIST = defineListState({ filters: { status: { values: ["paid", "refunded"] } },
 *     sortable: ["date", "status", "total"], defaultSort: { id: "date", desc: true }, pageSize: 8 });
 *   const list = useListState(ORDERS_LIST);
 *   <DataTable sorting={list.sorting} onSortingChange={list.onSortingChange}
 *     toolbar={{ search: { value: list.state.q, onChange: list.setQuery, placeholder: "Order or invoice number" } }}
 *     pagination={{ page: list.applied.page, pageSize: 8, total, onPageChange: list.setPage, pageHref: list.pageHref }}
 *     loading={list.isPending} ... />
 */
export function useListState<F extends string>(
  config: ListStateConfig<F>,
  options: UseListStateOptions = {},
): ListStateControls<F> {
  const { mode = "server", history = "replace", debounceMs = 300 } = options;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  const applied = React.useMemo(() => parseListState(searchParams, config), [searchParams, config]);
  const [state, setState] = React.useState<ListState<F>>(applied);
  // The state this hook last wrote to the URL (or read from it).
  const written = React.useRef<ListState<F>>(applied);

  // The URL changed without us (back/forward, a link, a server redirect): adopt it.
  React.useEffect(() => {
    if (sameListState(applied, written.current)) return;
    written.current = applied;
    setState(applied);
  }, [applied]);

  // Mirror the controls to the URL; typing in the search box is debounced.
  React.useEffect(() => {
    if (sameListState(state, written.current)) return;
    const typing = normalizeQuery(state.q) !== normalizeQuery(written.current.q);
    const timer = window.setTimeout(
      () => {
        written.current = state;
        const href = `${listStateHref(pathname, state, config, window.location.search)}${window.location.hash}`;
        if (mode === "client") {
          window.history.replaceState(null, "", href);
          return;
        }
        startTransition(() => {
          if (history === "push") router.push(href, { scroll: false });
          else router.replace(href, { scroll: false });
        });
      },
      typing ? debounceMs : 0,
    );
    return () => window.clearTimeout(timer);
  }, [state, pathname, config, mode, history, debounceMs, router]);

  const update = React.useCallback((patch: ListStatePatch<F>) => setState((current) => updateListState(current, patch)), []);
  const setQuery = React.useCallback((q: string) => update({ q }), [update]);
  const setFilter = React.useCallback(
    (id: F, value: string) => update({ filters: { [id]: value } as ListStatePatch<F>["filters"] }),
    [update],
  );
  const setSort = React.useCallback((sort: ListSort | null) => update({ sort }), [update]);
  const onSortingChange = React.useCallback((sorting: SortingState) => update({ sort: fromSortingState(sorting) }), [update]);
  const setPage = React.useCallback((page: number) => update({ page }), [update]);
  const setPageSize = React.useCallback((pageSize: number) => update({ pageSize }), [update]);
  const clear = React.useCallback(() => setState((current) => clearListFilters(current, config)), [config]);
  const sorting = React.useMemo(() => toSortingState(state.sort), [state.sort]);
  const pageHref = React.useCallback(
    (page: number) => listStateHref(pathname, { ...state, page }, config, searchParams.toString()),
    [pathname, state, config, searchParams],
  );

  return {
    state,
    applied,
    setQuery,
    setFilter,
    setSort,
    sorting,
    onSortingChange,
    setPage,
    setPageSize,
    update,
    clear,
    pageHref,
    isFiltered: isListFiltered(state, config),
    isPending,
  };
}
