"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { useCompare } from "@/lib/compare/use-compare";
import {
  CATALOG_PATH,
  CATALOG_SORTS,
  COMPARE_LIMIT_MESSAGE,
  activeFilterCount,
  catalogChips,
  catalogFacets,
  catalogHref,
  clearCatalogFilters,
  emptyStateSubject,
  filterCatalog,
  isCatalogSort,
  parseCatalogParams,
  removeCatalogChip,
  resultCountLabel,
  toggleFacetValue,
  type CatalogCategoryOption,
  type CatalogChip,
  type CatalogItem,
  type CatalogListFacet,
  type AvailabilityKey,
  type CatalogQuery,
  type PriceBandKey,
} from "@/lib/storefront/catalog-filter";
import { CatalogCard } from "./catalog-card";
import { ABOVE_COMPARE_TRAY, CompareTray } from "./compare-tray";
import { FilterPanel } from "./filter-panel";

/** The URL follows the search box after a pause in typing; every other change is written at once. */
const SEARCH_URL_DELAY_MS = 300;
/** tokens.screens.catalog: the sidebar shows from 900px, the drawer is used below. */
const WIDE_MEDIA = "(min-width: 56.25rem)";

export type CatalogViewProps = {
  items: readonly CatalogItem[];
  categories: readonly CatalogCategoryOption[];
  /** Parsed from the request URL by the server page, so the first paint (and no-JS) shows the same results. */
  initialQuery: CatalogQuery;
  /** GST rate for incl. prices (settings tax.gstRatePct). */
  ratePct: number;
};

function focusElement(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  el.focus();
  return true;
}

/**
 * The interactive part of /software: search, sort, filters (sticky sidebar, or a drawer below 900px), chips, the
 * results grid, the empty state and the compare tray. Filtering is client-side (small catalog) and the query is
 * mirrored to the URL with history.replaceState, so filtered views can be shared.
 */
export function CatalogView({ items, categories, initialQuery, ratePct }: CatalogViewProps) {
  const [query, setQuery] = useState<CatalogQuery>(initialQuery);
  // A soft navigation to another /software URL (a category link, "All software") re-renders the server page with a
  // new initial query while this component stays mounted: start over from it.
  const initialHref = catalogHref(initialQuery);
  const [renderedHref, setRenderedHref] = useState(initialHref);
  if (initialHref !== renderedHref) {
    setRenderedHref(initialHref);
    setQuery(initialQuery);
  }
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sortId = useId();
  const searchId = useId();
  const { ids: compareIds, ready: compareReady, toggle, remove, replace, MAX } = useCompare();

  const searchRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const chipFocus = useRef<number | null>(null);
  const focusSearchAfterClear = useRef(false);
  const written = useRef({ href: catalogHref(initialQuery), q: initialQuery.q.trim() });

  const categoryIds = useMemo(() => categories.map((c) => c.id), [categories]);
  const results = useMemo(() => filterCatalog(items, query), [items, query]);
  const facets = useMemo(() => catalogFacets(items, query, categories), [items, query, categories]);
  const chips = useMemo(() => catalogChips(query, categories), [query, categories]);
  const filterCount = activeFilterCount(query);

  // A page restored from history can carry a newer URL than the one the server rendered: the URL wins.
  useEffect(() => {
    const fromUrl = parseCatalogParams(new URLSearchParams(window.location.search), { categoryIds });
    if (catalogHref(fromUrl) !== catalogHref(initialQuery)) setQuery(fromUrl);
  }, [categoryIds, initialQuery]);

  // Mirror the query to the address bar (no history entries, no server round trip).
  useEffect(() => {
    const href = catalogHref(query);
    if (href === written.current.href) return;
    const q = query.q.trim();
    const timer = window.setTimeout(
      () => {
        window.history.replaceState(null, "", `${href}${window.location.hash}`);
        written.current = { href, q };
      },
      q !== written.current.q ? SEARCH_URL_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [query]);

  // The drawer only exists below 900px.
  useEffect(() => {
    const media = window.matchMedia(WIDE_MEDIA);
    const onChange = () => {
      if (media.matches) setFiltersOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Focus after a chip disappears: the chip that took its place, the previous one, or the search box.
  useEffect(() => {
    const index = chipFocus.current;
    if (index !== null) {
      chipFocus.current = null;
      const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-chip]");
      const target = buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : null;
      if (!focusElement(target)) focusElement(searchRef.current);
    }
    if (focusSearchAfterClear.current) {
      focusSearchAfterClear.current = false;
      focusElement(searchRef.current);
    }
  }, [chips]);

  // Compare selection: only products on sale count; stale ids (an unpublished or coming-soon product) are dropped.
  const itemsById = useMemo(() => new Map(items.filter((item) => !item.comingSoon).map((item) => [item.id, item])), [items]);
  const compared = useMemo(
    () => compareIds.flatMap((id) => (itemsById.has(id) ? [itemsById.get(id)!] : [])),
    [compareIds, itemsById],
  );
  const comparedIds = useMemo(() => new Set(compared.map((item) => item.id)), [compared]);
  useEffect(() => {
    if (compareReady && compared.length !== compareIds.length) replace(compared.map((item) => item.id));
  }, [compareReady, compared, compareIds, replace]);

  const onToggleCompare = useCallback(
    (id: string) => {
      const result = toggle(id);
      if (!result.ok) toast.info(COMPARE_LIMIT_MESSAGE, { id: "compare-limit", className: ABOVE_COMPARE_TRAY });
    },
    [toggle],
  );

  const onTrayRemove = useCallback(
    (id: string) => {
      const wasLast = compared.length === 1;
      remove(id);
      // The tray unmounts with its last chip: continue from that product's Compare checkbox.
      if (wasLast) {
        window.requestAnimationFrame(() => {
          const box = document.querySelector<HTMLElement>(`[data-compare-id="${CSS.escape(id)}"]`);
          if (!focusElement(box)) focusElement(searchRef.current);
        });
      }
    },
    [compared.length, remove],
  );

  const onToggleFacet = useCallback((facet: CatalogListFacet, value: string) => {
    setQuery((q) => toggleFacetValue(q, facet, value));
  }, []);
  const onPrice = useCallback((price: PriceBandKey) => setQuery((q) => ({ ...q, price })), []);
  const onAvailability = useCallback((availability: AvailabilityKey) => setQuery((q) => ({ ...q, availability })), []);
  const onClear = useCallback(() => setQuery(clearCatalogFilters), []);
  const onRemoveChip = (chip: CatalogChip, index: number) => {
    chipFocus.current = index;
    setQuery((q) => removeCatalogChip(q, chip));
  };

  const panel = (
    <FilterPanel facets={facets} onToggle={onToggleFacet} onAvailability={onAvailability} onPrice={onPrice} onClear={onClear} />
  );

  return (
    <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
      {/* A real GET form: without JavaScript, Enter in the search box still loads /software?q=... */}
      <form
        role="search"
        action={CATALOG_PATH}
        method="get"
        onSubmit={(event) => event.preventDefault()}
        className="mt-7 flex flex-wrap items-center gap-3"
      >
        <div className="relative flex-[1_1_320px]">
          <label htmlFor={searchId} className="sr-only">
            Search software
          </label>
          <Icon
            name="search"
            size={22}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <Input
            id={searchId}
            ref={searchRef}
            type="search"
            name="q"
            size="lg"
            value={query.q}
            onChange={(event) => {
              const q = event.target.value;
              setQuery((prev) => ({ ...prev, q }));
            }}
            placeholder="Search by name, feature or business type"
            autoComplete="off"
            enterKeyHint="search"
            className="pl-[46px] text-base sm:text-[15.5px]"
          />
        </div>
        {query.category.length > 0 ? <input type="hidden" name="category" value={query.category.join(",")} /> : null}
        {query.availability !== "all" ? <input type="hidden" name="availability" value={query.availability} /> : null}
        {query.price !== "any" ? <input type="hidden" name="price" value={query.price} /> : null}
        {query.os.length > 0 ? <input type="hidden" name="os" value={query.os.join(",")} /> : null}
        {query.license.length > 0 ? <input type="hidden" name="license" value={query.license.join(",")} /> : null}

        <SheetTrigger asChild>
          <button
            type="button"
            className="flex h-[50px] cursor-pointer items-center gap-2 rounded-14 border border-line-input bg-surface px-4 font-bold transition-colors hover:border-primary catalog:hidden"
          >
            <Icon name="tune" size={21} />
            Filters{filterCount > 0 ? ` (${filterCount})` : ""}
          </button>
        </SheetTrigger>

        <div className="flex items-center gap-2.5">
          <label htmlFor={sortId} className="text-[14.5px] font-bold">
            Sort
          </label>
          <ChoiceSelect
            id={sortId}
            name="sort"
            size="lg"
            value={query.sort}
            onValueChange={(sort) => {
              if (isCatalogSort(sort)) setQuery((prev) => ({ ...prev, sort }));
            }}
            options={CATALOG_SORTS}
            className="w-auto pl-3.5 text-[14.5px] font-semibold"
          />
        </div>
      </form>

      <div className="mt-6 grid items-start gap-8 catalog:grid-cols-[240px_minmax(0,1fr)]">
        {/* Sticky, and scrolls on its own once taller than the window (7 categories + availability), so every filter and
            its focus ring stay reachable; -mx-2 px-2 keeps the rows' negative margins and focus rings inside the box. */}
        <aside
          aria-label="Filters"
          className="scrollbar-subtle sticky top-[calc(var(--store-header-h)+24px)] -mx-2 hidden max-h-[calc(100dvh-var(--store-header-h)-48px)] overflow-y-auto overscroll-contain px-2 pb-2 catalog:block"
        >
          {panel}
        </aside>

        <section aria-label="Results" className="min-w-0">
          <div ref={chipsRef} className="flex min-h-[34px] flex-wrap items-center gap-2">
            <p role="status" className="m-0 mr-1.5 text-[14.5px] font-bold text-ink-2">
              {resultCountLabel(results.length)}
            </p>
            {chips.map((chip, index) => (
              <button
                key={chip.key}
                type="button"
                data-chip=""
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => onRemoveChip(chip, index)}
                className="flex cursor-pointer items-center gap-1 rounded-pill border border-lavender-line bg-lavender-soft py-[7.5px] pl-3 pr-2 text-[13.5px] font-bold text-lavender-fg transition-colors hover:border-primary-accent"
              >
                {chip.label}
                <Icon name="close" size={17} />
              </button>
            ))}
          </div>

          {results.length === 0 ? (
            <div className="mt-4 rounded-24 border border-dashed border-line-input bg-surface p-[clamp(32px,5vw,56px)] text-center">
              <span className="mx-auto grid size-16 place-items-center rounded-20 bg-lavender-bg text-lavender-fg">
                <Icon name="search_off" size={32} />
              </span>
              <h2 className="mt-[18px] text-[22px] font-extrabold">No software matches {emptyStateSubject(query)}</h2>
              <p className="mx-auto mt-2.5 max-w-[460px] text-[15.5px] leading-[1.6] text-ink-2">
                Try a different search term or remove a filter. If you can’t find what your business needs, tell us —
                we use these requests to plan new products.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2.5">
                <Button
                  type="button"
                  className="px-5 py-3 text-base"
                  onClick={() => {
                    focusSearchAfterClear.current = true;
                    onClear();
                  }}
                >
                  Clear search and filters
                </Button>
                <Button asChild variant="secondary" className="px-5 py-3 text-base">
                  <Link href="/contact">Request software</Link>
                </Button>
              </div>
            </div>
          ) : (
            <ul className="m-0 mt-4 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-5 p-0">
              {results.map((item) => (
                <li key={item.id} className="flex">
                  <CatalogCard
                    item={item}
                    compared={comparedIds.has(item.id)}
                    onToggleCompare={onToggleCompare}
                    ratePct={ratePct}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <SheetContent
        side="right"
        showClose={false}
        aria-describedby={undefined}
        className="block max-w-[380px] overflow-y-auto border-l-0 px-6 py-5 leading-[normal]"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <SheetTitle className="text-[20px] font-extrabold">Filters</SheetTitle>
          <SheetClose
            aria-label="Close filters"
            className="grid size-10 cursor-pointer place-items-center rounded-12 border border-line bg-surface text-ink transition-colors hover:bg-slate-bg"
          >
            <Icon name="close" size={22} />
          </SheetClose>
        </div>
        {panel}
        <SheetClose asChild>
          <Button type="button" className="mt-5 h-[50px] w-full rounded-14 text-base">
            Show {results.length} {results.length === 1 ? "result" : "results"}
          </Button>
        </SheetClose>
      </SheetContent>

      {compareReady && compared.length > 0 ? (
        <CompareTray items={compared} max={MAX} onRemove={onTrayRemove} />
      ) : null}
    </Sheet>
  );
}
