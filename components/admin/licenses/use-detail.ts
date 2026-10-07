"use client";

import * as React from "react";
import { errorMessage } from "@/components/admin/admin-toaster";
import { apiFetch } from "@/lib/client/api";

export type DetailState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Fetches again (after an action), keeping the current data on screen meanwhile. */
  reload: () => void;
};

/**
 * Loads one drawer's details from an admin API path (null = nothing open). A newer request aborts the older one, so a
 * quick row switch never shows stale details; `pick` takes the record out of the response envelope.
 */
export function useAdminDetail<R, T>(path: string | null, pick: (response: R) => T): DetailState<T> {
  const [state, setState] = React.useState<{ path: string | null; data: T | null; error: string | null; loading: boolean }>({
    path: null,
    data: null,
    error: null,
    loading: false,
  });
  const [version, setVersion] = React.useState(0);
  const pickRef = React.useRef(pick);
  pickRef.current = pick;

  React.useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((s) => (s.path === path ? { ...s, loading: true, error: null } : { path, data: null, error: null, loading: true }));
    apiFetch<R>(path, { signal: controller.signal })
      .then((response) => setState({ path, data: pickRef.current(response), error: null, loading: false }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState((s) => ({ ...s, path, error: errorMessage(error, "We couldn\u2019t load these details. Try again."), loading: false }));
      });
    return () => controller.abort();
  }, [path, version]);

  const reload = React.useCallback(() => setVersion((v) => v + 1), []);
  const current = state.path === path;
  return {
    data: current ? state.data : null,
    loading: !!path && (!current || (state.loading && state.data === null)),
    error: current ? state.error : null,
    reload,
  };
}
