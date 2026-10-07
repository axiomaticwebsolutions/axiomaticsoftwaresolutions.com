"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { adminNavGroups, badgeLabel, badgeText, moduleKeyForPath } from "@/components/admin/admin-nav";
import { cn } from "@/lib/utils";

/** Keyboard focus on the dark sidebar: the light accent ring (8:1 on the sidebar; the primary ring is under 3:1). */
export const SIDEBAR_FOCUS = "[&_:focus-visible]:outline-primary-accent";

export type AdminSidebarProps = {
  /** Called when a link is followed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** The drawer's close button, shown at the end of the logo row. */
  closeButton?: React.ReactNode;
};

/**
 * Sidebar content (Admin Console.dc.html aside): logo row with "ADMIN CONSOLE", the grouped module nav (current
 * module highlighted, a lock on modules the role cannot open, count badges on Orders and Tickets) and the
 * "View storefront" link. Rendered in the 232px sticky column from 1040px and in the mobile drawer below that.
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
    <div className={cn("flex h-full min-h-0 flex-col bg-admin-sidebar text-admin-text", SIDEBAR_FOCUS)}>
      <div className="flex items-center gap-2.5 border-b border-white/8 px-3.5 pb-2.5 pt-3.5">
        <LogoMark size={30} />
        <span className="flex-1 leading-[1.1]">
          <span className="block text-[15.5px] font-extrabold text-white">Axiomatic</span>
          <span className="block text-[11px] font-bold tracking-[0.08em] text-admin-text/85">ADMIN CONSOLE</span>
        </span>
        {closeButton}
      </div>
      <nav aria-label="Admin" className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-2 py-2.5">
        {groups.map((group) => {
          const headingId = `${uid}-${group.group.toLowerCase()}`;
          return (
            <div key={group.group}>
              <p id={headingId} className="m-0 px-2.5 py-1 text-[10.5px] font-extrabold tracking-[0.1em] text-admin-text/70">
                {group.label}
              </p>
              <ul aria-labelledby={headingId} className="m-0 grid list-none p-0">
                {group.items.map((item) => {
                  const active = item.key === current;
                  return (
                    <li key={item.key} className="grid">
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-2.5 rounded-9 px-2.5 py-[9px] text-[13.5px] font-semibold leading-[normal] no-underline transition-colors",
                          active ? "bg-admin-active text-white hover:text-white" : "text-admin-text hover:bg-white/7 hover:text-white",
                        )}
                      >
                        <Icon name={item.icon} size={19} />
                        <span className="min-w-0 flex-1">{item.label}</span>
                        {item.locked ? (
                          <>
                            <Icon name="lock" size={15} className="text-admin-text/70" />
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
      <div className="border-t border-white/8 p-3">
        <Link
          href="/"
          onClick={onNavigate}
          className="inline-flex items-center gap-1.5 rounded-6 text-[12.5px] font-bold text-admin-text no-underline hover:text-white"
        >
          <Icon name="open_in_new" size={16} />
          View storefront
        </Link>
      </div>
    </div>
  );
}
