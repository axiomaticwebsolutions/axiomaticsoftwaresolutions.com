"use client";

import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";
import { withParam } from "@/components/admin/model";

/** Default search parameter that holds the open drawer's row id (decisions.md Phase 6: `?id=`). */
export const DRAWER_PARAM = "id";

/** history.state marker for an entry this hook pushed, so closing can step back instead of stacking entries. */
const STATE_KEY = "axsDrawer";

type DrawerHistoryState = { [STATE_KEY]?: string } | null;

export type DrawerParam = {
  /** The open row id, or null when no drawer is open. */
  id: string | null;
  isOpen: boolean;
  /**
   * Opens the drawer for `id`: a new history entry (so Back closes it), or a replaced one when a drawer is already
   * open (switching rows never stacks entries). No server round trip: Next syncs useSearchParams with
   * history.pushState / replaceState.
   */
  open: (id: string) => void;
  /** Closes the drawer: steps back over the entry open() pushed, else removes the parameter in place. */
  close: () => void;
  /** Link to the current page with the drawer open on `id` (shareable; keeps filters, sort and page). */
  href: (id: string) => string;
  /** Change handler for <AdminDrawer onOpenChange>. */
  onOpenChange: (open: boolean) => void;
};

/**
 * The admin drawer's row id kept in the URL (`?id=AX-10262`), so a drawer can be linked to, survives a reload and
 * closes with Back. Use with <AdminDrawer open={drawer.isOpen} onOpenChange={drawer.onOpenChange}> and
 * `onRowClick={(row) => drawer.open(row.id)}`. Uses useSearchParams, so a statically rendered page needs a
 * <Suspense> boundary around the component that calls it.
 */
export function useDrawerParam(param: string = DRAWER_PARAM): DrawerParam {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get(param);
  const id = raw && raw.trim() ? raw : null;

  const open = React.useCallback(
    (next: string) => {
      const url = new URL(window.location.href);
      const current = url.searchParams.get(param);
      if (current === next) return;
      const target = `${url.pathname}${withParam(url.search, param, next)}${url.hash}`;
      const state = window.history.state as DrawerHistoryState;
      if (current) {
        // Switching rows: replace, keeping the marker when this entry was ours. Never pass Next's own state object
        // back (its __NA flag makes Next skip syncing the URL into useSearchParams).
        window.history.replaceState(state?.[STATE_KEY] ? { [STATE_KEY]: next } : null, "", target);
      } else {
        window.history.pushState({ [STATE_KEY]: next }, "", target);
      }
    },
    [param],
  );

  const close = React.useCallback(() => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(param);
    if (!current) return;
    const state = window.history.state as DrawerHistoryState;
    if (state?.[STATE_KEY]) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", `${url.pathname}${withParam(url.search, param, null)}${url.hash}`);
  }, [param]);

  const href = React.useCallback(
    (next: string) => `${pathname}${withParam(searchParams.toString(), param, next)}`,
    [pathname, searchParams, param],
  );

  const onOpenChange = React.useCallback((next: boolean) => {
    if (!next) close();
  }, [close]);

  return { id, isOpen: id !== null, open, close, href, onOpenChange };
}
