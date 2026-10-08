"use client";

import * as React from "react";
import type { AdminCustomerRow } from "@/lib/admin/customers/model";
import { apiFetch } from "@/lib/client/api";

/**
 * Customer account search for admin pickers ("Issue license", "New order"): GET /api/admin/customers?q= (customers.view)
 * after 250 ms of no typing, at least 2 characters, at most 6 rows by business name. Stale requests are aborted.
 */
export function useAccountSearch(query: string): { results: AdminCustomerRow[]; loading: boolean } {
  const [results, setResults] = React.useState<AdminCustomerRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      apiFetch<{ items: AdminCustomerRow[] }>(`/api/admin/customers?q=${encodeURIComponent(q)}&pageSize=6&sort=business`, { signal: controller.signal })
        .then((r) => setResults(r.items))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return { results, loading };
}
