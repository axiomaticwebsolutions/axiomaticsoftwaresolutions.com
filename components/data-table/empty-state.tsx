import type * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/icons/icon";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import type { DataTableVariant } from "@/components/data-table/types";

export type DataTableEmptyStateProps = {
  /** The message, e.g. "No licenses match these filters." */
  children: React.ReactNode;
  /** Optional heading above the message (first-use empty states). */
  title?: React.ReactNode;
  /** Inline action after the message, e.g. <EmptyStateAction onClick={clear}>Clear filters</EmptyStateAction>. */
  action?: React.ReactNode;
  icon?: IconName;
  /** "error" uses role="alert" and the danger colour for the icon. */
  tone?: "neutral" | "error";
  variant?: DataTableVariant;
  className?: string;
};

/**
 * Empty (or failed) table body, centred under the header like the prototype: "No orders match." Server-safe.
 */
export function DataTableEmptyState({
  children,
  title,
  action,
  icon,
  tone = "neutral",
  variant = "portal",
  className,
}: DataTableEmptyStateProps) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      data-slot="data-table-empty"
      className={cn("grid justify-items-center gap-1.5 text-center text-ink-2", VARIANT_STYLES[variant].empty, className)}
    >
      {icon ? (
        <Icon name={icon} size={28} className={cn("mb-1", tone === "error" ? "text-danger" : "text-muted-icon")} />
      ) : null}
      {title ? <p className="text-[15.5px] font-extrabold text-ink">{title}</p> : null}
      <p className="max-w-[560px]">
        {children}
        {action ? <> {action}</> : null}
      </p>
    </div>
  );
}

/** Where keyboard focus goes after a table's filters were cleared: the toolbar search (or its first control). */
export const TOOLBAR_FOCUS_SELECTOR =
  '[data-slot="data-table-toolbar"] input[type="search"], [data-slot="data-table-toolbar"] select, [data-slot="data-table-toolbar"] button';

/**
 * Moves focus into the toolbar of the table around `from` on the next frame (the table frame itself if it has no
 * toolbar control), as the toolbar's own Clear does. Used when the control that cleared the filters goes away.
 */
export function focusTableToolbar(from: Element): void {
  const frame = from.closest<HTMLElement>('[data-slot="data-table"]');
  if (!frame) return;
  window.requestAnimationFrame(() => {
    if (!frame.isConnected) return;
    (frame.querySelector<HTMLElement>(TOOLBAR_FOCUS_SELECTOR) ?? frame).focus();
  });
}

/**
 * Link-style button for empty states ("Clear filters", "Try again"). With `clearsFilters` the empty state (and this
 * button) disappears once rows come back, so focus moves to the table's search field instead of falling to <body>.
 */
export function EmptyStateAction({
  className,
  type = "button",
  clearsFilters = false,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { clearsFilters?: boolean }) {
  return (
    <button
      type={type}
      className={cn(
        "cursor-pointer rounded-6 font-bold text-primary-link hover:text-primary-link-hover hover:underline",
        className,
      )}
      onClick={
        clearsFilters
          ? (event) => {
              const button = event.currentTarget;
              onClick?.(event);
              focusTableToolbar(button);
            }
          : onClick
      }
      {...props}
    />
  );
}
