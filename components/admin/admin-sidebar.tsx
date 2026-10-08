"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { adminNavGroups, badgeLabel, badgeText, moduleKeyForPath } from "@/components/admin/admin-nav";
import type { AdminModuleGroup } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/** Keyboard focus on the light sidebar: the primary ring, like the rest of the console. */
export const SIDEBAR_FOCUS = "[&_:focus-visible]:outline-primary";

/**
 * Pastel per nav group (lib/design/tokens.ts tones; owner decision 2026-10-08: a light sidebar with several pastel
 * colours instead of the prototype's dark navy one). `tile` colours the icon square, `current` the whole row of the
 * open module, `hover` the row under the pointer. Every text/icon pair is a tone fg on its own bg (5:1 or more).
 */
const GROUP_TONE: Record<AdminModuleGroup, { tile: string; current: string; hover: string }> = {
  DASHBOARD: { tile: "bg-lavender-bg text-lavender-fg", current: "bg-lavender-bg text-lavender-fg", hover: "hover:bg-lavender-soft" },
  CATALOG: { tile: "bg-blue-bg text-blue-fg", current: "bg-blue-bg text-blue-fg", hover: "hover:bg-blue-soft" },
  SALES: { tile: "bg-sage-bg text-sage-fg", current: "bg-sage-bg text-sage-fg", hover: "hover:bg-sage-soft" },
  LICENSING: { tile: "bg-peach-bg text-peach-fg", current: "bg-peach-bg text-peach-fg", hover: "hover:bg-peach-soft" },
  SUPPORT: { tile: "bg-pink-bg text-pink-fg", current: "bg-pink-bg text-pink-fg", hover: "hover:bg-pink-soft" },
  CONTENT: { tile: "bg-lavender-bg text-lavender-fg", current: "bg-lavender-bg text-lavender-fg", hover: "hover:bg-lavender-soft" },
  INSIGHTS: { tile: "bg-blue-bg text-blue-fg", current: "bg-blue-bg text-blue-fg", hover: "hover:bg-blue-soft" },
  ADMINISTRATION: { tile: "bg-slate-bg text-slate-fg", current: "bg-slate-bg text-ink", hover: "hover:bg-bg" },
};

export type AdminSidebarProps = {
  /** Called when a link is followed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** The drawer's close button, shown at the end of the logo row. */
  closeButton?: React.ReactNode;
};

/**
 * Sidebar content (Admin Console.dc.html aside, restyled light): logo row with "ADMIN CONSOLE", the grouped module nav
 * (each group in its own pastel, the current module filled with it, a lock on modules the role cannot open, count
 * badges on Orders and Tickets) and the "View storefront" link. Rendered in the 232px sticky column from 1040px and in
 * the mobile drawer below that. Links are 30px tall so the whole menu fits a 900px-high window; shorter windows scroll
 * the nav with a thin scrollbar (.scrollbar-subtle in app/globals.css).
 * The prototype's demo "Signed in as" switcher is not built (staff sign in with their own accounts).
 */
export function AdminSidebar({ onNavigate, closeButton }: AdminSidebarProps) {
  const pathname = usePathname();
  const { modules } = useAdmin();
  const current = moduleKeyForPath(pathname);
  const groups = adminNavGroups(modules);
  // Unique per instance: the drawer can be open while the (hidden) desktop column is still in the DOM.
  const uid = React.useId();

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface text-ink", SIDEBAR_FOCUS)}>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 pb-2.5 pt-3.5">
        <LogoMark size={30} />
        <span className="flex-1 leading-[1.1]">
          <span className="block text-[15.5px] font-extrabold text-ink">Axiomatic</span>
          <span className="block text-[11px] font-bold tracking-[0.08em] text-ink-3">ADMIN CONSOLE</span>
        </span>
        {closeButton}
      </div>
      <nav aria-label="Admin" className="scrollbar-subtle grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-2 py-2">
        {groups.map((group) => {
          const headingId = `${uid}-${group.group.toLowerCase()}`;
          const tone = GROUP_TONE[group.group];
          return (
            <div key={group.group}>
              <p id={headingId} className="m-0 px-2 pb-1 pt-0.5 text-[10.5px] font-extrabold tracking-[0.1em] text-ink-3">
                {group.label}
              </p>
              <ul aria-labelledby={headingId} className="m-0 grid list-none gap-px p-0">
                {group.items.map((item) => {
                  const active = item.key === current;
                  return (
                    <li key={item.key} className="grid">
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-2.5 rounded-10 px-1.5 py-[3px] text-[13.5px] leading-[normal] no-underline transition-colors",
                          active ? cn(tone.current, "font-bold") : cn("font-semibold text-ink-body hover:text-ink", tone.hover),
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn("grid size-6 shrink-0 place-items-center rounded-8", active ? "bg-surface" : tone.tile)}
                        >
                          <Icon name={item.icon} size={16} />
                        </span>
                        <span className="min-w-0 flex-1">{item.label}</span>
                        {item.locked ? (
                          <>
                            <Icon name="lock" size={15} className="text-ink-3" />
                            <span className="sr-only">, restricted</span>
                          </>
                        ) : null}
                        {item.badge > 0 ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="min-w-5 rounded-pill bg-primary px-1.5 py-px text-center text-[11px] font-extrabold text-white"
                            >
                              {badgeText(item.badge)}
                            </span>
                            <span className="sr-only">, {badgeLabel(item.key, item.badge)}</span>
                          </>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line p-3">
        <Link
          href="/"
          onClick={onNavigate}
          className="inline-flex items-center gap-1.5 rounded-6 text-[12.5px] font-bold text-ink-2 no-underline hover:text-primary-link"
        >
          <Icon name="open_in_new" size={16} />
          View storefront
        </Link>
      </div>
    </div>
  );
}
