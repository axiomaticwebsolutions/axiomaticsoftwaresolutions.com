"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons/icon";
import { compareHref } from "@/lib/storefront/derive";

/** CSS variable (on <html>) holding the tray height while it is shown, so toasts can sit above it. */
export const COMPARE_TRAY_VAR = "--compare-tray-h";

/** Per-toast class that lifts a bottom toast above the tray (0 when the tray is hidden). */
export const ABOVE_COMPARE_TRAY = "mb-[calc(var(--compare-tray-h,0px)+12px)]";

export type CompareTrayProps = {
  /** Selected products, in selection order (1 to max). */
  items: readonly { id: string; shortName: string }[];
  max: number;
  /** Removes one product (focus moves to the neighbouring chip, or the CTA). */
  onRemove: (id: string) => void;
};

/**
 * Fixed dark tray at the bottom of the catalog (Software.dc.html): "Compare n/3", removable chips and the CTA to
 * /compare?ids=... ("Add one more" below two products, "Compare now" otherwise). Client-only.
 */
export function CompareTray({ items, max, onRemove }: CompareTrayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);

  // Publish the tray height for toasts; remove it when the tray goes away.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty(COMPARE_TRAY_VAR, `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(COMPARE_TRAY_VAR);
    };
  }, []);

  // After a chip is removed, focus the chip that took its place (or the previous one, or the CTA).
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>("button[data-tray-remove]");
    const target = buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : null;
    (target ?? ref.current?.querySelector<HTMLAnchorElement>("a"))?.focus();
  }, [items]);

  const ids = items.map((item) => item.id);
  return (
    <div
      ref={ref}
      role="region"
      aria-label="Compare tray"
      className="fixed bottom-5 left-1/2 z-40 flex w-[min(760px,calc(100%-24px))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-20 bg-ink py-3 pl-5 pr-3 text-white shadow-[0_20px_50px_--alpha(theme(colors.ink)/30%)]"
    >
      <span className="text-[14.5px] font-extrabold">
        Compare {items.length}/{max}
      </span>
      <ul className="m-0 flex flex-1 list-none flex-wrap gap-1.5 p-0">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-1 rounded-pill bg-white/12 py-1.5 pl-3 pr-1.5 text-[13.5px] font-semibold"
          >
            {item.shortName}
            <button
              type="button"
              data-tray-remove=""
              aria-label={`Remove ${item.shortName} from comparison`}
              onClick={() => {
                pendingFocus.current = index;
                onRemove(item.id);
              }}
              className="-mx-[3px] grid h-[22px] w-6 cursor-pointer place-items-center rounded-pill text-white transition-colors hover:bg-white/15 focus-visible:outline-white"
            >
              <Icon name="close" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <Link
        href={compareHref(ids)}
        className="rounded-12 bg-surface px-[18px] py-[11px] text-[14.5px] font-extrabold text-ink no-underline transition-colors hover:bg-lavender-bg hover:text-ink focus-visible:outline-white"
      >
        {items.length < 2 ? "Add one more" : "Compare now"}
      </Link>
    </div>
  );
}
