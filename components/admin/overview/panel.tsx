import Link from "next/link";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Panel header link (prototype: 12.5px/700, underlined link colour). */
export const PANEL_LINK =
  "rounded-6 text-[12.5px] font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover";

export type DashboardPanelProps = {
  /** Heading id (the section's accessible name). */
  id: string;
  title: React.ReactNode;
  /** Right side of the header: a total, a link or an export button. */
  aside?: React.ReactNode;
  /** Spans every column of the panel grid (wide tables). */
  wide?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
};

/**
 * Overview / Reports panel (Admin Console.dc.html): white card, radius 14, 1px line, a 12x16px header with a
 * 14.5px/800 H2 and an optional aside, then the body, which grows so panels in a row end level. Server-safe.
 */
export function DashboardPanel({ id, title, aside, wide = false, className, bodyClassName, children }: DashboardPanelProps) {
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col rounded-14 border border-line-alt bg-surface", wide && "col-span-full", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-subtle px-4 py-3">
        <h2 id={id} className="m-0 text-[14.5px] font-extrabold leading-[normal]">
          {title}
        </h2>
        {aside}
      </div>
      {/* The body takes the extra height, but its own rows stay packed at the top (content-start). */}
      <div className={cn("flex-1 content-start", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A header link into another module, or nothing when the role cannot open it. */
export function PanelLink({ href, show, children }: { href: string; show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return (
    <Link href={href} className={PANEL_LINK}>
      {children}
    </Link>
  );
}

/** Grid of panels (prototype: auto-fit, 460px minimum, 14px gap). Panels in a row share one height (owner request 2026-10-08). */
export function PanelGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] items-stretch gap-3.5", className)}>{children}</div>;
}
