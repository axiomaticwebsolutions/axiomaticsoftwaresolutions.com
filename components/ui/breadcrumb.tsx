import type * as React from "react";
import * as Slot from "radix-ui/slot";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";

/** Breadcrumb trail: nav aria-label="Breadcrumb", "/" separators hidden from assistive tech. Server-safe. */
export function Breadcrumb({ "aria-label": ariaLabel = "Breadcrumb", ...props }: React.ComponentProps<"nav">) {
  return <nav data-slot="breadcrumb" aria-label={ariaLabel} {...props} />;
}

export function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 break-words text-[14px] font-semibold text-ink-2", className)}
      {...props}
    />
  );
}

export function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="breadcrumb-item" className={cn("inline-flex min-w-0 items-center gap-1.5", className)} {...props} />;
}

/** A crumb link. Use asChild with next/link: <BreadcrumbLink asChild><Link href="/">Home</Link></BreadcrumbLink>. */
export function BreadcrumbLink({ asChild = false, className, ...props }: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn("rounded-6 underline-offset-4 transition-colors hover:text-ink hover:underline", className)}
      {...props}
    />
  );
}

/** The current page (last crumb). */
export function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="breadcrumb-page" aria-current="page" className={cn("truncate text-ink", className)} {...props} />
  );
}

export function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("text-ink-3", className)}
      {...props}
    >
      {children ?? "/"}
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="breadcrumb-ellipsis" className={cn("inline-flex items-center", className)} {...props}>
      <Icon name="more_horiz" size={18} />
      <span className="sr-only">More pages</span>
    </span>
  );
}
