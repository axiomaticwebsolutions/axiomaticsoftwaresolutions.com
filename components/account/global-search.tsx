"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import {
  normalizeSearchResponse,
  SEARCH_DEBOUNCE_MS,
  SEARCH_GROUPS,
  SEARCH_MIN_CHARS,
  type PortalSearchResult,
} from "@/components/account/portal-nav";
import { useCommandShortcut } from "@/components/ui/command";
import { apiFetch } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type SearchState = { query: string; status: "loading" | "ready" | "error"; results: PortalSearchResult[] };
type View = "results" | "searching" | "empty" | "error";

export const SEARCH_ERROR_MESSAGE = "Search isn\u2019t available right now. Try again in a moment.";

function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * Global search in the top bar (prototype #ax-search): licenses (id, product, key last 4), devices, orders and
 * tickets from GET /api/account/search, debounced, from 2 characters. An ARIA combobox: the results popup opens
 * under the field (full width under the bar on phones), grouped by type; Up/Down move, Enter opens, Escape closes
 * (a second Escape clears), Ctrl/Cmd+K focuses the field from anywhere. Order results open with a full page load
 * (order pages carry their own CSP).
 */
export function GlobalSearch({ className }: { className?: string }) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState<SearchState | null>(null);
  const [active, setActive] = React.useState(0);
  const uid = React.useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-opt-${index}`;
  const term = query.trim();
  const ready = term.length >= SEARCH_MIN_CHARS;

  useCommandShortcut(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  });

  React.useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearch((prev) => ({ query: term, status: "loading", results: prev?.results ?? [] }));
      apiFetch<unknown>(`/api/account/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((body) => {
          setSearch({ query: term, status: "ready", results: normalizeSearchResponse(body) });
          setActive(0);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setSearch({ query: term, status: "error", results: [] });
          setActive(0);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [term, ready]);

  const results = search?.results ?? [];
  const current = search && search.query === term ? search : null;
  let view: View;
  if (current?.status === "error") view = "error";
  else if (current?.status === "ready") view = results.length > 0 ? "results" : "empty";
  else view = results.length > 0 ? "results" : "searching";
  const shown = open && ready;
  const activeIndex = view === "results" ? Math.min(active, results.length - 1) : -1;

  // aria-activedescendant moves the highlight but not the popup's scroll: keep the highlighted option in view.
  React.useEffect(() => {
    if (!shown || activeIndex < 0) return;
    document.getElementById(`${uid}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [shown, activeIndex, uid]);

  const go = (result: PortalSearchResult) => {
    setOpen(false);
    setQuery("");
    setSearch(null);
    inputRef.current?.blur();
    if (result.fullPageLoad) window.location.assign(result.href);
    else router.push(result.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = view === "results" ? results.length : 0;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        else if (count > 0) setActive((i) => (Math.min(i, count - 1) + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        else if (count > 0) setActive((i) => (Math.min(i, count - 1) - 1 + count) % count);
        break;
      case "Enter": {
        const target = shown && activeIndex >= 0 ? results[activeIndex] : undefined;
        if (target) {
          event.preventDefault();
          go(target);
        }
        break;
      }
      case "Escape":
        // Also stops the browser clearing a search field on Escape: the first Escape only closes the results.
        event.preventDefault();
        event.stopPropagation();
        if (shown) setOpen(false);
        else if (query) setQuery("");
        else inputRef.current?.blur();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const status =
    !shown || view === "searching"
      ? ""
      : view === "error"
        ? SEARCH_ERROR_MESSAGE
        : view === "empty"
          ? `No matches for \u201c${term}\u201d.`
          : `${results.length} ${results.length === 1 ? "result" : "results"}`;

  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  const message = view === "searching" ? "Searching\u2026" : view === "results" ? "" : status;
  let index = -1;

  return (
    <div className={cn("relative min-w-0 max-w-[520px] flex-1", className)}>
      <label
        htmlFor={inputId}
        className="flex h-[38px] cursor-text items-center gap-2 rounded-10 border border-line-alt bg-bg px-2.5 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-focus"
      >
        <Icon name="search" size={19} className="text-ink-3" />
        <span className="sr-only">Search your account</span>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-keyshortcuts="Control+K Meta+K"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Search licenses, keys, devices, orders, tickets"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] font-semibold text-ink outline-none placeholder:text-ink-3 focus-visible:outline-hidden"
        />
        <kbd
          aria-hidden="true"
          className="hidden rounded-6 border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11.5px] leading-[normal] text-ink-2 min-[45rem]:inline"
        >
          Ctrl K
        </kbd>
      </label>
      <div
        hidden={!shown}
        className={cn(
          // The listbox itself scrolls (not this wrapper): it is the combobox popup, which arrow keys scroll through
          // aria-activedescendant, so it needs no Tab stop (axe scrollable-region-focusable exempts combobox popups).
          "absolute inset-x-0 top-11 z-40 flex max-h-[420px] flex-col rounded-14 border border-line-alt bg-surface p-1.5 shadow-menu",
          // Phones: the field is narrow, so the results use the width of the screen under the bar.
          "max-[45rem]:fixed max-[45rem]:inset-x-3.5 max-[45rem]:top-[62px] max-[45rem]:max-h-[calc(100dvh-78px)]",
        )}
      >
        {message ? <p className="m-0 shrink-0 p-3.5 text-[14px] text-ink-2">{message}</p> : null}
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          tabIndex={-1}
          onMouseDown={keepFocus}
          className="min-h-0 overflow-y-auto"
        >
          {view === "results"
            ? SEARCH_GROUPS.map((group) => {
                const items = results.filter((r) => r.kind === group.kind);
                if (items.length === 0) return null;
                const headingId = `${uid}-${group.kind}`;
                return (
                  <div key={group.kind} role="group" aria-labelledby={headingId}>
                    <span id={headingId} className="sr-only">
                      {group.heading}
                    </span>
                    {items.map((result) => {
                      index += 1;
                      const i = index;
                      const selected = i === activeIndex;
                      return (
                        <a
                          key={`${result.kind}:${result.id}:${i}`}
                          id={optionId(i)}
                          role="option"
                          aria-selected={selected}
                          href={result.href}
                          tabIndex={-1}
                          onMouseMove={() => setActive(i)}
                          onClick={(event) => {
                            if (isModifiedClick(event)) return;
                            event.preventDefault();
                            go(result);
                          }}
                          className={cn(
                            "flex items-center gap-2.5 rounded-10 px-2.5 py-[9px] text-ink no-underline hover:text-ink",
                            selected && "bg-lavender-soft",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className="grid size-[30px] flex-none place-items-center rounded-9 bg-slate-bg text-ink-2"
                          >
                            <Icon name={group.icon} size={18} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-[14px] font-bold">{result.title}</span>
                            {result.subtitle ? (
                              <span className="block break-words text-[12.5px] font-semibold text-ink-2">{result.subtitle}</span>
                            ) : null}
                          </span>
                          <span aria-hidden="true" className="shrink-0 text-[11.5px] font-extrabold tracking-[0.06em] text-ink-2">
                            {group.type}
                          </span>
                        </a>
                      );
                    })}
                  </div>
                );
              })
            : null}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
    </div>
  );
}
