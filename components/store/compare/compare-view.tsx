"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES, toIconName } from "@/components/store/active-nav";
import { NativeSelect } from "@/components/ui/native-select";
import { parseCompareParam } from "@/lib/compare/store";
import { useCompare } from "@/lib/compare/use-compare";
import { formatINR } from "@/lib/money";
import { CATALOG_PATH } from "@/lib/storefront/catalog-filter";
import { compareHref, productHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";
import {
  compareRows,
  joinNames,
  slotIds,
  toSlots,
  type CompareCell,
  type CompareProduct,
  type CompareRow,
  type CompareSlots,
} from "./compare-model";

export type CompareViewProps = {
  /** Every published product, by rank (selector options and table data). */
  products: readonly CompareProduct[];
  /** From ?ids= when the URL has it, otherwise the default columns. */
  initialSlots: CompareSlots;
};

type RowGroup = { label: string; rows: Extract<CompareRow, { kind: "row" }>[] };

function groupRows(rows: readonly CompareRow[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    if (row.kind === "group") groups.push({ label: row.label, rows: [] });
    else groups.at(-1)?.rows.push(row);
  }
  return groups;
}

/** A 28px line box around the 21px mark, like the prototype's icon-font glyph (icon rows are 57px tall). */
const MARK_BOX = "inline-grid h-7 place-items-center align-middle";

function Cell({ cell }: { cell: CompareCell }) {
  if (cell.kind === "yes")
    return (
      <span className={MARK_BOX}>
        <Icon name="check_circle" size={21} label="Included" className="text-success" />
      </span>
    );
  if (cell.kind === "no")
    return (
      <span className={MARK_BOX}>
        <Icon name="remove" size={21} label="Not included" className="text-muted-icon" />
      </span>
    );
  return <>{cell.text}</>;
}

const stickyCell = "sticky left-0 z-[1] border-r border-line-subtle";

/**
 * /compare (Compare.dc.html): three product selectors, the "pick at least two" state and the comparison table.
 * The selection is shared with the catalog tray: links (?ids=) are adopted into the saved selection, a bare /compare
 * shows the saved selection, and every change updates both the saved selection and the address bar.
 */
export function CompareView({ products, initialSlots }: CompareViewProps) {
  const [slots, setSlots] = useState<CompareSlots>(initialSlots);
  // A soft navigation to another /compare URL re-renders the server page while this component stays mounted.
  const initialKey = initialSlots.join(",");
  const [renderedKey, setRenderedKey] = useState(initialKey);
  if (initialKey !== renderedKey) {
    setRenderedKey(initialKey);
    setSlots(initialSlots);
  }
  const { ids: savedIds, ready, replace } = useCompare();
  const syncedFor = useRef<string | null>(null);
  const selectRefs = useRef<(HTMLSelectElement | null)[]>([]);
  const focusSlot = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState<boolean | null>(null);
  const captionId = useId();
  const hintId = useId();

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const selected = useMemo(
    () => slots.flatMap((id) => (id && byId.has(id) ? [byId.get(id)!] : [])),
    [slots, byId],
  );
  const groups = useMemo(() => groupRows(compareRows(selected)), [selected]);

  // Once the saved selection can be read (after hydration), reconcile it with the URL, once per server render.
  useEffect(() => {
    if (!ready || syncedFor.current === initialKey) return;
    syncedFor.current = initialKey;
    const params = new URLSearchParams(window.location.search);
    if (params.has("ids")) {
      // A link (or a restored history entry): the URL wins and becomes the saved selection.
      const urlSlots = toSlots(parseCompareParam(params.getAll("ids").join(",")), products);
      const ids = slotIds(urlSlots);
      if (ids.join() !== slotIds(slots).join()) setSlots(urlSlots);
      if (ids.length > 0) replace(ids);
      return;
    }
    // Bare /compare: show what the visitor picked on the catalog, if anything.
    const saved = slotIds(toSlots(savedIds, products));
    if (saved.length !== savedIds.length) replace(saved);
    if (saved.length > 0) {
      setSlots(toSlots(saved));
      window.history.replaceState(null, "", compareHref(saved));
    }
  }, [ready, initialKey, savedIds, products, replace, slots]);

  // After "Remove", continue from that slot's selector.
  useEffect(() => {
    const index = focusSlot.current;
    if (index === null) return;
    focusSlot.current = null;
    selectRefs.current[index]?.focus();
  }, [slots]);

  // Show the "scroll sideways" hint only while the table is wider than its frame.
  const columnCount = selected.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [columnCount]);

  const commit = (next: CompareSlots) => {
    setSlots(next);
    const ids = slotIds(next);
    replace(ids);
    window.history.replaceState(null, "", compareHref(ids));
  };
  const onSelect = (index: number, id: string) => {
    const next: CompareSlots = [...slots];
    next[index] = id;
    commit(next);
  };
  const onRemove = (id: string) => {
    focusSlot.current = slots.indexOf(id);
    commit(slots.map((x) => (x === id ? "" : x)) as CompareSlots);
  };

  const showHint = overflowing ?? true;
  return (
    <>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {slots.map((value, index) => (
          <label
            key={index}
            className="grid min-w-0 gap-1.5 text-[13px] font-extrabold uppercase tracking-[0.06em] text-ink-2"
          >
            <span className="whitespace-nowrap">Product {index + 1}</span>
            <NativeSelect
              ref={(el) => {
                selectRefs.current[index] = el;
              }}
              value={value}
              onChange={(event) => onSelect(index, event.target.value)}
              className="h-12 rounded-13 pl-3 text-[15px] font-bold normal-case tracking-normal"
            >
              <option value="">Choose a product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id !== value && slots.includes(p.id)}>
                  {p.shortName}
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
      </div>

      {selected.length < 2 ? (
        <div className="mt-6 rounded-22 border border-dashed border-line-input bg-surface p-10 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
            <Icon name="compare_arrows" size={28} />
          </span>
          <h2 className="mt-3.5 text-[20px] font-extrabold">Pick at least two products to compare</h2>
          <p className="mt-1.5 text-ink-2">
            Use the selectors above, or tick “Compare” on the{" "}
            <Link
              href={CATALOG_PATH}
              className="rounded-6 font-semibold text-primary-link underline-offset-4 hover:text-primary-link-hover hover:underline"
            >
              software catalog
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          {showHint ? (
            <p
              id={hintId}
              className={cn(
                "mt-6 flex items-center gap-2 text-[13.5px] font-semibold text-ink-2",
                overflowing === null && "cards:hidden",
              )}
            >
              <Icon name="swap_horiz" size={18} />
              Scroll sideways to see every product.
            </p>
          ) : null}
          <div
            ref={scrollRef}
            role="region"
            aria-labelledby={captionId}
            aria-describedby={showHint ? hintId : undefined}
            // A scrollable region must be reachable by keyboard to scroll it (axe scrollable-region-focusable).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={showHint ? 0 : undefined}
            className={cn(
              // relative: the containing block for the visually hidden text inside, so it scrolls (and clips) with the table.
              "relative overflow-x-auto rounded-22 border border-line bg-surface",
              showHint ? "mt-3" : "mt-6",
              overflowing === null && "cards:mt-6",
            )}
          >
            <table
              className={cn(
                "w-full border-separate border-spacing-0 text-[15px]",
                selected.length > 2 ? "min-w-[760px]" : "min-w-[560px]",
              )}
            >
              <caption id={captionId} className="sr-only">
                Comparison of {joinNames(selected.map((p) => p.shortName))}
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={cn(
                      stickyCell,
                      "w-[22%] bg-surface px-5 py-[18px] text-left align-bottom text-[12.5px] font-bold uppercase tracking-[0.06em] text-ink-2",
                    )}
                  >
                    Feature
                  </th>
                  {selected.map((p, i) => (
                    <th
                      key={p.id}
                      scope="col"
                      className={cn("px-4 py-[18px] text-left align-top", i > 0 && "border-l border-line-subtle")}
                    >
                      <span className={cn("grid size-[42px] place-items-center rounded-12", TONE_TILE_CLASSES[p.tone])}>
                        <Icon name={toIconName(p.icon)} size={23} />
                      </span>
                      <span className="mt-2.5 block text-[16.5px] font-extrabold text-ink">{p.shortName}</span>
                      {p.startingPricePaise !== null ? (
                        <span className="mt-1 block text-[14px] font-semibold text-ink-2">
                          From <strong className="font-extrabold text-ink">{formatINR(p.startingPricePaise)}</strong>{" "}
                          {p.startingUnit}
                        </span>
                      ) : null}
                      <span className="mt-3 flex flex-wrap gap-2">
                        <Link
                          href={`${productHref(p.id)}#plans`}
                          className="rounded-[11px] bg-primary px-3.5 py-[9px] text-[14px] font-bold text-white no-underline transition-colors hover:bg-primary-hover hover:text-white"
                        >
                          View plans<span className="sr-only"> for {p.shortName}</span>
                        </Link>
                        <button
                          type="button"
                          onClick={() => onRemove(p.id)}
                          className="cursor-pointer rounded-[11px] border border-line-input bg-surface px-3 py-[9px] text-[14px] font-bold text-ink transition-colors hover:border-primary"
                        >
                          Remove<span className="sr-only"> {p.shortName}</span>
                        </button>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.label}>
                  <tr>
                    <th
                      scope="rowgroup"
                      className={cn(
                        stickyCell,
                        "border-t bg-bg px-5 py-3.5 text-left text-[12.5px] font-extrabold uppercase text-ink-2",
                      )}
                    >
                      {group.label}
                    </th>
                    {selected.map((p, i) => (
                      <td key={p.id} className={cn("border-t border-line-subtle bg-bg", i > 0 && "border-l")} />
                    ))}
                  </tr>
                  {group.rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row" className={cn(stickyCell, "border-t bg-surface px-5 py-3.5 text-left font-bold text-ink")}>
                        {row.label}
                      </th>
                      {row.cells.map((cell, i) => (
                        <td
                          key={selected[i]?.id ?? i}
                          className={cn("border-t border-line-subtle px-4 py-3.5 font-semibold", i > 0 && "border-l")}
                        >
                          <Cell cell={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </>
  );
}
