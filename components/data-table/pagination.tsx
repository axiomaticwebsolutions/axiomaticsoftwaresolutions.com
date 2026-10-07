"use client";

import type * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { pageControlState, pageItems } from "@/components/data-table/model";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableVariant, PaginationStyle } from "@/components/data-table/types";

export type PaginationProps = {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  pageHref?: (page: number) => string;
  style?: PaginationStyle;
  /** Accessible name of the nav (default "Pagination"). */
  label?: string;
  variant?: DataTableVariant;
  className?: string;
};

/**
 * Pagination as <nav aria-label> with a list. The current page carries aria-current="page" (visually hidden
 * "Page 2 of 5" in the portal's Previous / Next style). Controls at the ends use aria-disabled rather than disabled,
 * and each control keeps its element type in every state (links with pageHref, buttons without), so React reuses
 * the focused element and keyboard focus is not dropped to the page when the first or last page is reached.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  pageHref,
  style = "prev-next",
  label = "Pagination",
  variant = "portal",
  className,
}: PaginationProps) {
  const styles = VARIANT_STYLES[variant];
  const current = Math.min(Math.max(1, page), Math.max(1, pageCount));
  const base = cn(
    "inline-flex cursor-pointer items-center justify-center border border-line-strong bg-surface font-bold text-ink no-underline",
    "transition-colors duration-150 hover:border-primary aria-disabled:cursor-not-allowed aria-disabled:border-line-strong aria-disabled:text-ink-3",
    styles.pageButton,
  );

  const target = (to: number, children: React.ReactNode, extra: { label?: string; className?: string; current?: boolean } = {}) => {
    // An unavailable end keeps a link to the current page, so it stays the same element type (see pageControlState).
    const state = pageControlState(to, current, pageCount, !!pageHref, extra.current);
    return (
      <PageControl
        to={to}
        disabled={state.disabled}
        current={extra.current}
        href={state.kind === "link" && pageHref ? pageHref(state.page) : undefined}
        onPageChange={onPageChange}
        ariaLabel={extra.label}
        className={cn(base, extra.className)}
      >
        {children}
      </PageControl>
    );
  };

  const status = `Page ${current} of ${Math.max(1, pageCount)}`;

  return (
    <nav aria-label={label} className={className}>
      <ul className="flex flex-wrap items-center gap-1.5">
        {style === "compact" ? (
          <>
            <li>{target(current - 1, <Icon name="chevron_left" size={18} />, { label: "Previous page", className: "size-[30px] p-0" })}</li>
            <li aria-current="page" className="px-0.5">
              {status}
            </li>
            <li>{target(current + 1, <Icon name="chevron_right" size={18} />, { label: "Next page", className: "size-[30px] p-0" })}</li>
          </>
        ) : null}
        {style === "prev-next" ? (
          <>
            <li>{target(current - 1, "Previous")}</li>
            <li aria-current="page" className="sr-only">
              {status}
            </li>
            <li>{target(current + 1, "Next")}</li>
          </>
        ) : null}
        {style === "numbered" ? (
          <>
            <li>{target(current - 1, <Icon name="chevron_left" size={18} />, { label: "Previous page", className: "size-[30px] p-0" })}</li>
            {pageItems(current, pageCount).map((item, index) =>
              item === "gap" ? (
                <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-3">
                  …
                </li>
              ) : (
                <li key={item}>
                  {target(item, item, {
                    label: `Page ${item}`,
                    current: item === current,
                    className: cn(
                      "h-[30px] min-w-[30px] px-1.5 py-0 tabular",
                      item === current && "border-primary bg-lavender-bg text-lavender-fg hover:border-primary",
                    ),
                  })}
                </li>
              ),
            )}
            <li>{target(current + 1, <Icon name="chevron_right" size={18} />, { label: "Next page", className: "size-[30px] p-0" })}</li>
          </>
        ) : null}
      </ul>
    </nav>
  );
}

function PageControl({
  to,
  disabled,
  current,
  href,
  onPageChange,
  ariaLabel,
  className,
  children,
}: {
  to: number;
  disabled: boolean;
  current?: boolean;
  href?: string;
  onPageChange: (page: number) => void;
  ariaLabel?: string;
  className: string;
  children: React.ReactNode;
}) {
  const inactive = disabled || !!current;
  if (href) {
    // Always a link here, enabled or not: swapping <a> for <button> when Next reaches the last page would replace
    // the focused element and drop keyboard focus to <body>.
    return (
      <Link
        href={href}
        scroll={false}
        prefetch={inactive ? false : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        aria-current={current ? "page" : undefined}
        className={className}
        onClick={(event) => {
          if (inactive) {
            event.preventDefault();
            return;
          }
          // Plain clicks page in place (the caller syncs the URL); modified clicks open the link normally.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onPageChange(to);
        }}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-current={current ? "page" : undefined}
      className={className}
      onClick={() => {
        if (!disabled && !current) onPageChange(to);
      }}
    >
      {children}
    </button>
  );
}
