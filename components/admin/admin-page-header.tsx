import Link from "next/link";
import type * as React from "react";
import { ADMIN_HOME } from "@/components/admin/admin-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type AdminPageHeaderProps = {
  /** Breadcrumb group in sentence case ("Sales"); the trail reads "Admin / {group} / {title}" ("Admin / {title}" without). */
  group?: string;
  /** The H1. null renders a heading-sized skeleton (pages titled by data that is still loading). */
  title: React.ReactNode;
  /** Breadcrumb text for the page when the title is not plain text. */
  crumb?: string;
  description?: React.ReactNode;
  /** Right-aligned actions (AdminAction, DestructiveAction). */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * Admin page header (prototype): breadcrumb "Admin / Sales / Orders, payments & refunds" (12.5px/600), H1
 * clamp(20px, 2.2vw, 24px)/800, description 13.5px up to 760px, actions wrapping on the right. Server-safe.
 */
export function AdminPageHeader({ group, title, crumb, description, actions, className }: AdminPageHeaderProps) {
  const current = crumb ?? (typeof title === "string" ? title : null);
  const trail = [group, current].filter((part): part is string => !!part);
  return (
    <div className={cn("mb-4", className)}>
      <nav aria-label="Breadcrumb" className="mb-2">
        <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[12.5px] font-semibold text-ink-2">
          <li className="inline-flex items-center gap-1.5">
            <Link href={ADMIN_HOME} className="rounded-6 text-ink-2 no-underline hover:text-ink">
              Admin
            </Link>
          </li>
          {trail.map((part, i) => {
            const last = i === trail.length - 1 && current !== null;
            return (
              <li key={`${i}:${part}`} aria-current={last ? "page" : undefined} className="inline-flex min-w-0 items-center gap-1.5 text-ink">
                <span aria-hidden="true" className="text-ink-2">
                  /
                </span>
                {part}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2.5">
        <div className="min-w-0">
          {title === null ? (
            <Skeleton alt className="h-[30px] w-[min(320px,70vw)] rounded-8" />
          ) : (
            <h1 className="m-0 text-[clamp(20px,2.2vw,24px)] font-extrabold leading-[normal] tracking-[-0.02em]">{title}</h1>
          )}
          {description ? <p className="mb-0 mt-[3px] max-w-[760px] text-[13.5px] leading-[normal] text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
