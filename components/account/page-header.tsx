"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { DisabledAction } from "@/components/account/disabled-action";
import { usePortalOptional } from "@/components/account/portal-context";
import { breadcrumbTrail, type Crumb } from "@/components/account/portal-nav";
import type { TeamPermission } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export type { Crumb };

export type PageHeaderProps = {
  /** The H1. null renders a heading-sized skeleton bar instead (loading states of pages titled by their data). */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (usually <PageAction>s). */
  actions?: React.ReactNode;
  /**
   * The whole trail, business first. Default: derived from the URL as in the prototype ("{business} / Licenses /
   * LIC-24017", "... / Tickets / New ticket"). Pass `false` to leave the breadcrumb out.
   */
  breadcrumb?: Crumb[] | false;
  className?: string;
};

/**
 * Portal page header (prototype): breadcrumb (13px/600, "/" separators, the last crumb is the current page), H1
 * clamp(22px, 2.4vw, 28px)/800, description 14.5px max 720px, actions wrapping on the right.
 */
export function PageHeader({ title, description, actions, breadcrumb, className }: PageHeaderProps) {
  const pathname = usePathname();
  const portal = usePortalOptional();
  const trail = breadcrumb === false ? [] : (breadcrumb ?? breadcrumbTrail(pathname, portal?.account.legalName ?? "Account"));
  return (
    <div className={cn("mb-5", className)}>
      {trail.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2.5">
          <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[13px] font-semibold text-ink-2">
            {trail.map((crumb, i) => {
              const last = i === trail.length - 1;
              return (
                <li key={`${crumb.href}:${i}`} className="inline-flex min-w-0 items-center gap-1.5">
                  <Link
                    href={crumb.href}
                    aria-current={last ? "page" : undefined}
                    className={cn("rounded-6 no-underline", last ? "text-ink hover:text-ink" : "text-ink-2 hover:text-ink")}
                  >
                    {crumb.label}
                  </Link>
                  {last ? null : (
                    <span aria-hidden="true" className="text-ink-3">
                      /
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
        <div className="min-w-0">
          {title === null ? (
            <Skeleton alt className="h-[34px] w-[min(320px,70vw)] rounded-8" />
          ) : (
            <h1 className="m-0 text-[clamp(22px,2.4vw,28px)] font-extrabold leading-[normal] tracking-[-0.025em]">{title}</h1>
          )}
          {description ? (
            <p className="mb-0 mt-1 max-w-[720px] text-[14.5px] leading-[1.5] text-ink-2">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export type PageActionVariant = "primary" | "outline" | "danger";

const ACTION_BASE =
  "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-10 px-3.5 py-[9px] text-[14px] font-bold leading-[normal] no-underline transition-colors aria-busy:cursor-progress";

const ACTION_VARIANTS: Record<PageActionVariant, string> = {
  primary: "border border-primary bg-primary text-white hover:border-primary-hover hover:bg-primary-hover hover:text-white",
  outline: "border border-line-input bg-surface text-ink hover:border-primary hover:text-ink",
  danger: "border border-pink-line bg-surface text-danger hover:border-danger-border hover:bg-pink-soft hover:text-danger",
};

/** Classes of a page-header action (prototype: 9x14px, radius 10, 14px/700, 18px icon). */
export function pageActionClassName(variant: PageActionVariant = "outline", className?: string): string {
  return cn(ACTION_BASE, ACTION_VARIANTS[variant], className);
}

export type PageActionProps = {
  children: React.ReactNode;
  variant?: PageActionVariant;
  icon?: IconName;
  /** A link instead of a button. */
  href?: string;
  /** Full page load (plain <a>), e.g. for /orders/:id, /checkout or downloads. */
  external?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  /** Team permission the action needs: without it the action is disabled with "Requires ..." (DisabledAction). */
  perm?: TeamPermission;
  busy?: boolean;
  className?: string;
};

/** A page-header action button or link in the prototype style; gated by `perm` when given. */
export function PageAction({ children, variant = "outline", icon, href, external, onClick, perm, busy, className }: PageActionProps) {
  const portal = usePortalOptional();
  const classes = pageActionClassName(variant, className);
  const content = (
    <>
      {icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </>
  );
  if (perm && portal && !portal.can(perm)) {
    return (
      <DisabledAction perm={perm} asChild>
        <button type="button" className={classes}>
          {content}
        </button>
      </DisabledAction>
    );
  }
  if (href) {
    return external ? (
      <a href={href} className={classes}>
        {content}
      </a>
    ) : (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={busy ? undefined : onClick} aria-busy={busy || undefined} className={classes}>
      {content}
    </button>
  );
}
