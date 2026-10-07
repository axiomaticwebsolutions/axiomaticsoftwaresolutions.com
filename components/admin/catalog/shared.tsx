"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { downloadFromApi } from "@/components/account/activity/download-file";
import { adminToast, errorMessage } from "@/components/admin/admin-toaster";
import { Icon } from "@/components/icons/icon";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { listStateToParams, type ListState, type ListStateConfig } from "@/lib/url-state";
import { cn } from "@/lib/utils";

/** Prototype table cell: a bold (or regular) first line and an optional 11.5px muted second line. */
export function TwoLine({ top, bottom, bold = false, className }: { top: React.ReactNode; bottom?: React.ReactNode; bold?: boolean; className?: string }) {
  return (
    <>
      <span className={cn("block", bold ? "font-extrabold" : "font-semibold", className)}>{top}</span>
      {bottom ? <span className="mt-px block text-[11.5px] font-semibold text-ink-2">{bottom}</span> : null}
    </>
  );
}

export type Detail<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void; set: (next: T) => void };

/**
 * Loads a drawer's detail from `url` (null = nothing open). A new url discards the previous data; reload() refetches
 * in place (after a mutation) without blanking the drawer.
 */
export function useDetail<T>(url: string | null, pick: (body: unknown) => T): Detail<T> {
  const [state, setState] = React.useState<{ url: string | null; data: T | null; error: string | null }>({ url: null, data: null, error: null });
  const [nonce, setNonce] = React.useState(0);
  const pickRef = React.useRef(pick);
  pickRef.current = pick;

  React.useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    apiFetch<unknown>(url, { signal: controller.signal })
      .then((body) => setState({ url, data: pickRef.current(body), error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof ApiClientError && error.status === 404 ? "This record doesn\u2019t exist or was removed." : errorMessage(error);
        setState({ url, data: null, error: message });
      });
    return () => controller.abort();
  }, [url, nonce]);

  const current = state.url === url ? state : { url, data: null, error: null };
  return {
    data: url ? current.data : null,
    error: url ? current.error : null,
    loading: !!url && current.data === null && current.error === null,
    reload: React.useCallback(() => setNonce((n) => n + 1), []),
    set: React.useCallback((next: T) => setState({ url, data: next, error: null }), [url]),
  };
}

/** router.refresh() in a transition: the server list re-renders after a mutation. */
export function useRefresh(): { refresh: () => void; refreshing: boolean } {
  const router = useRouter();
  const [refreshing, start] = React.useTransition();
  const refresh = React.useCallback(() => start(() => router.refresh()), [router]);
  return { refresh, refreshing };
}

/** First message per field of a 422 (keys as the server sends them, e.g. "content.features.0.icon"). */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!(error instanceof ApiClientError)) return {};
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(error.fieldErrors)) if (messages[0]) out[key] = messages[0];
  return out;
}

/** Form-level message for a failed save: the field summary for a 422, else the server's message. */
export function formErrorOf(error: unknown): string {
  if (error instanceof ApiClientError && error.code === "validation_failed") return "Please fix the highlighted fields.";
  return errorMessage(error);
}

/** An inline alert under a form (role="alert"). */
export function FormAlert({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-10 border border-pink-line bg-pink-soft px-3 py-2.5 text-[13px] font-bold text-danger">
      <Icon name="error" size={17} className="mt-px shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Two columns from 520px, one below. */
export function FormGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid items-start gap-2.5 min-[32.5rem]:grid-cols-2", className)}>{children}</div>;
}

/** The export URL for the list's search, filters and sort (every matching row, not just the page). */
export function exportHref<F extends string>(path: string, state: ListState<F>, config: ListStateConfig<F>): string {
  const params = listStateToParams({ ...state, page: 1 }, config);
  params.delete("page");
  params.delete("pageSize");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Downloads a server CSV export and toasts "Exported {n} rows · {file}" (prototype copy). */
export async function exportCsv(href: string, fallbackName: string): Promise<void> {
  try {
    const { fileName, headers } = await downloadFromApi(href, fallbackName);
    const rows = Number(headers.get("x-row-count") ?? "0") || 0;
    const count = `${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"}`;
    adminToast.success(headers.get("x-truncated") === "1" ? `Exported the first ${count} \u00B7 ${fileName}` : `Exported ${count} \u00B7 ${fileName}`);
  } catch (error) {
    adminToast.error(error, "The export didn\u2019t finish. Try again.");
  }
}

/** Options for a DataTable filter: "All" first. */
export function filterOptions(entries: readonly (readonly [string, string])[]): { value: string; label: string }[] {
  return [{ value: "all", label: "All" }, ...entries.map(([value, label]) => ({ value, label }))];
}

/** Replaces search parameters in place (Next syncs useSearchParams with history.replaceState; no server request). */
export function replaceParams(patch: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
