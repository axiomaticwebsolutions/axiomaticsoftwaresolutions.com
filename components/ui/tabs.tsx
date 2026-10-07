"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

type TabsVariant = "underline" | "pill";

const TabsVariantContext = React.createContext<TabsVariant>("underline");

/** Tabs (role="tablist", arrow keys move between tabs). */
export function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("grid gap-4", className)} {...props} />;
}

export type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List> & {
  /** underline = portal/admin detail tabs; pill = white selected chip on slate (screenshot tabs, OS tabs). */
  variant?: TabsVariant;
};

export function TabsList({ className, variant = "underline", ...props }: TabsListProps) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(
          "flex max-w-full overflow-x-auto overflow-y-hidden [scrollbar-width:thin]",
          variant === "underline" ? "gap-1 border-b border-line" : "w-fit gap-0.5 rounded-12 bg-slate-bg p-1",
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

/**
 * Radix focuses a trigger from script on mousedown, which Chrome treats as :focus-visible, so a mouse click left the
 * focus ring on the tab. data-pointer-focus marks pointer focus (set on pointerdown, cleared on blur or any key) and
 * hides the outline only then; keyboard focus, including arrow-key moves, keeps the ring.
 */
/**
 * Scrolls a tab's list sideways (only the list, never the page) so the whole tab is visible. Underline tab lists
 * scroll on narrow screens, and browsers leave a focused or selected tab clipped at the edge.
 */
export function scrollTabIntoView(tab: HTMLElement | null | undefined): void {
  const list = tab?.closest<HTMLElement>('[role="tablist"]');
  if (!tab || !list || list.scrollWidth <= list.clientWidth) return;
  const listBox = list.getBoundingClientRect();
  const tabBox = tab.getBoundingClientRect();
  if (tabBox.left < listBox.left) list.scrollLeft -= listBox.left - tabBox.left;
  else if (tabBox.right > listBox.right) list.scrollLeft += tabBox.right - listBox.right;
}

/** Keeps the selected tab inside `container` in view whenever `value` changes (and on mount, for deep links). */
export function useActiveTabInView(container: React.RefObject<HTMLElement | null>, value: string): void {
  React.useEffect(() => {
    scrollTabIntoView(container.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]'));
  }, [container, value]);
}

export function TabsTrigger({
  className,
  onPointerDown,
  onKeyDown,
  onBlur,
  onFocus,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      onPointerDown={(event) => {
        event.currentTarget.dataset.pointerFocus = "";
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        delete event.currentTarget.dataset.pointerFocus;
        onKeyDown?.(event);
      }}
      onBlur={(event) => {
        delete event.currentTarget.dataset.pointerFocus;
        onBlur?.(event);
      }}
      onFocus={(event) => {
        scrollTabIntoView(event.currentTarget);
        onFocus?.(event);
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap font-bold text-ink-2 transition-[color,background-color,border-color,box-shadow] duration-150",
        "hover:text-ink disabled:pointer-events-none disabled:opacity-50 data-[pointer-focus]:outline-none",
        variant === "underline"
          ? "rounded-t-8 border-b-2 border-transparent px-3 py-2.5 text-[14px] focus-visible:-outline-offset-2 data-[state=active]:border-primary data-[state=active]:text-ink"
          : "rounded-9 px-3 py-1.5 text-[13.5px] data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-tile",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("rounded-8 focus-visible:outline-offset-4", className)}
      {...props}
    />
  );
}
