"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { ADMIN_HOME, adminNavGroups, badgeLabel, badgeText, initialsOf, moduleKeyForPath } from "@/components/admin/admin-nav";
import { useStaffSignOut } from "@/components/admin/sign-out";
import { ADMIN_PROFILE_PATH } from "@/lib/admin/profile/model";
import { STAFF_ROLE_LABELS, type AdminModuleGroup } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/** Keyboard focus on the light sidebar: the primary ring, like the rest of the console. */
export const SIDEBAR_FOCUS = "[&_:focus-visible]:outline-primary";

/**
 * Pastel per nav group (lib/design/tokens.ts tones; owner decisions 2026-10-08): `icon` colours the group's icons,
 * `current` fills the open module's row, `hover` the row under the pointer. Text and icons on a fill are the tone's fg
 * on its own bg (5:1 or more).
 */
const GROUP_TONE: Record<AdminModuleGroup, { icon: string; current: string; hover: string }> = {
  DASHBOARD: { icon: "text-lavender-fg", current: "bg-lavender-bg text-lavender-fg", hover: "hover:bg-lavender-soft" },
  CATALOG: { icon: "text-blue-fg", current: "bg-blue-bg text-blue-fg", hover: "hover:bg-blue-soft" },
  SALES: { icon: "text-sage-fg", current: "bg-sage-bg text-sage-fg", hover: "hover:bg-sage-soft" },
  LICENSING: { icon: "text-peach-fg", current: "bg-peach-bg text-peach-fg", hover: "hover:bg-peach-soft" },
  SUPPORT: { icon: "text-pink-fg", current: "bg-pink-bg text-pink-fg", hover: "hover:bg-pink-soft" },
  CONTENT: { icon: "text-lavender-fg", current: "bg-lavender-bg text-lavender-fg", hover: "hover:bg-lavender-soft" },
  INSIGHTS: { icon: "text-blue-fg", current: "bg-blue-bg text-blue-fg", hover: "hover:bg-blue-soft" },
  ADMINISTRATION: { icon: "text-slate-fg", current: "bg-slate-bg text-ink", hover: "hover:bg-bg" },
};

/** Footer icon buttons (same as the customer portal's sidebar). */
const ICON_BUTTON =
  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-9 border-0 bg-transparent text-ink-2 no-underline transition-colors hover:bg-slate-bg hover:text-ink aria-busy:cursor-progress";

export type AdminSidebarProps = {
  /** Called when a link is followed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** The drawer's close button, shown at the end of the logo row. */
  closeButton?: React.ReactNode;
};

/**
 * Sidebar content, laid out like the customer portal's sidebar (owner request 2026-10-08) in the admin's colours: logo
 * row, the grouped module nav (uppercase group labels, 36px rows with 20px icons in each group's pastel, the open module
 * filled with it, a lock on modules the role cannot open, count badges on Orders and Tickets), then the signed-in staff
 * member (initials, name and role -> My profile) with View storefront and Sign out buttons. Rendered in the 256px sticky
 * column from 1040px and in the mobile drawer below that. A window shorter than the menu scrolls the nav only, with a
 * thin scrollbar (.scrollbar-subtle in app/globals.css); the logo row and the footer stay in view.
 */
export function AdminSidebar({ onNavigate, closeButton }: AdminSidebarProps) {
  const pathname = usePathname();
  const { modules, staff } = useAdmin();
  const current = moduleKeyForPath(pathname);
  const groups = adminNavGroups(modules);
  const { signOut, busy } = useStaffSignOut();
  // Unique per instance: the drawer can be open while the (hidden) desktop column is still in the DOM.
  const uid = React.useId();
  const role = STAFF_ROLE_LABELS[staff.role];
  const onProfile = pathname === ADMIN_PROFILE_PATH;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface text-ink", SIDEBAR_FOCUS)}>
      <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-4">
        <Link href={ADMIN_HOME} aria-label="Admin overview" onClick={onNavigate} className="block h-[35px] flex-none rounded-9">
          <LogoMark size={30} />
        </Link>
        <span className="min-w-0 flex-1 leading-[1.1]">
          <span className="block text-[16px] font-extrabold tracking-[-0.02em]">Axiomatic</span>
          <span className="block text-[11px] font-bold tracking-[0.08em] text-ink-3">ADMIN CONSOLE</span>
        </span>
        {closeButton}
      </div>
      <nav aria-label="Admin" className="scrollbar-subtle grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-2.5 py-1">
        {groups.map((group) => {
          const headingId = `${uid}-${group.group.toLowerCase()}`;
          const tone = GROUP_TONE[group.group];
          return (
            <div key={group.group}>
              <p id={headingId} className="m-0 px-2.5 pb-1 pt-1.5 text-[11px] font-extrabold uppercase tracking-[0.09em] text-ink-3">
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
                          "flex items-center gap-2.5 rounded-10 px-2.5 py-2 text-[14px] font-bold leading-[normal] no-underline transition-colors",
                          active ? tone.current : cn("text-ink-soft hover:text-ink-soft", tone.hover),
                        )}
                      >
                        <Icon name={item.icon} size={20} className={active ? undefined : tone.icon} />
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
                              className="min-w-5 rounded-pill bg-primary px-1.5 py-px text-center text-[11.5px] font-extrabold text-white"
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
      <div className="flex items-center gap-1.5 border-t border-line-subtle p-3">
        <Link
          href={ADMIN_PROFILE_PATH}
          onClick={onNavigate}
          aria-current={onProfile ? "page" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-10 p-1 no-underline transition-colors",
            onProfile ? "bg-lavender-bg" : "hover:bg-bg",
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-[34px] flex-none place-items-center rounded-pill bg-lavender-bg text-[13px] font-extrabold text-lavender-fg"
          >
            {initialsOf(staff.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-extrabold text-ink">{staff.name}</span>
            {/* ink-2, not ink-3: it also sits on the lavender fill while My profile is open (4.5:1 needed). */}
            <span className="block truncate text-[12px] font-semibold text-ink-2">{role} · My profile</span>
          </span>
        </Link>
        <Link href="/" aria-label="View storefront" title="View storefront" onClick={onNavigate} className={ICON_BUTTON}>
          <Icon name="storefront" size={19} />
        </Link>
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          aria-busy={busy || undefined}
          onClick={() => void signOut()}
          className={ICON_BUTTON}
        >
          <Icon name="logout" size={19} />
        </button>
      </div>
    </div>
  );
}
