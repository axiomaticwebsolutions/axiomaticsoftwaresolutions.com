"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { UploadedLogo, useBrandLogo } from "@/components/brand/branding-context";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { adminNavGroups, badgeLabel, badgeText, initialsOf, moduleKeyForPath } from "@/components/admin/admin-nav";
import { ADMIN_PROFILE_PATH } from "@/lib/admin/profile/model";
import { adminGroupTitle, STAFF_ROLE_LABELS, type AdminModuleGroup } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/** Keyboard focus on the light sidebar: the primary ring, like the rest of the console. */
export const SIDEBAR_FOCUS = "[&_:focus-visible]:outline-primary";

/**
 * Pastel per nav group (lib/design/tokens.ts tones; owner decision 2026-10-08, design "C, clean minimal"): `icon`
 * colours the group's icons, `current` fills the open module's row, `hover` the row under the pointer. Text and
 * icons on a fill are the tone's fg on its own bg (5:1 or more).
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

export type AdminSidebarProps = {
  /** Called when a link is followed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** The drawer's close button, shown at the end of the logo row. */
  closeButton?: React.ReactNode;
};

/**
 * Sidebar content (Admin Console.dc.html aside, restyled light and minimal): logo row with "ADMIN CONSOLE"; the
 * module nav in groups named in sentence case and split by hairlines, each group's icons in its own pastel, the open
 * module's row filled with it, a lock on modules the role cannot open and count badges on Orders and Tickets; then
 * the signed-in staff member (initials, name, role -> My profile) with a "View storefront" button. Rendered in the
 * 232px sticky column from 1040px and in the mobile drawer below that. Rows are about 29px so the whole menu fits a
 * 900px-high window; shorter windows scroll the nav with a thin scrollbar (.scrollbar-subtle in app/globals.css).
 */
export function AdminSidebar({ onNavigate, closeButton }: AdminSidebarProps) {
  const pathname = usePathname();
  const { modules, staff } = useAdmin();
  const current = moduleKeyForPath(pathname);
  const groups = adminNavGroups(modules);
  // Unique per instance: the drawer can be open while the (hidden) desktop column is still in the DOM.
  const uid = React.useId();
  const role = STAFF_ROLE_LABELS[staff.role];
  const onProfile = pathname === ADMIN_PROFILE_PATH;
  // The logo uploaded for light backgrounds (Admin > Settings > Branding), on one row with the console label so the
  // header keeps the built-in height (the row is at least as tall as the 30 px built-in mark).
  const uploaded = useBrandLogo();

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface text-ink", SIDEBAR_FOCUS)}>
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 pb-2.5 pt-3.5">
        {uploaded ? (
          <span className="flex min-h-[30px] min-w-0 flex-1 items-center gap-2">
            <UploadedLogo image={uploaded} height={28} maxWidth={120} />
            <span className="block min-w-0 flex-1 text-[11px] font-bold leading-[1.1] tracking-[0.08em] text-ink-3">ADMIN CONSOLE</span>
          </span>
        ) : (
          <>
            <LogoMark size={30} />
            <span className="flex-1 leading-[1.1]">
              <span className="block text-[15.5px] font-extrabold text-ink">Axiomatic</span>
              <span className="block text-[11px] font-bold tracking-[0.08em] text-ink-3">ADMIN CONSOLE</span>
            </span>
          </>
        )}
        {closeButton}
      </div>
      <nav aria-label="Admin" className="scrollbar-subtle grid min-h-0 flex-1 content-start overflow-y-auto px-2 py-1.5">
        {groups.map((group, index) => {
          const headingId = `${uid}-${group.group.toLowerCase()}`;
          const tone = GROUP_TONE[group.group];
          return (
            <div key={group.group} className={cn(index > 0 && "mt-1 border-t border-line-subtle pt-1")}>
              <p id={headingId} className="m-0 px-2 pb-0.5 pt-1.5 text-[11.5px] font-bold text-ink-3">
                {adminGroupTitle(group.group)}
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
                          "flex items-center gap-2.5 rounded-9 px-2 py-[5px] text-[13.5px] leading-[normal] no-underline transition-colors",
                          active ? cn(tone.current, "font-bold") : cn("font-semibold text-ink-body hover:text-ink", tone.hover),
                        )}
                      >
                        <Icon name={item.icon} size={18} className={active ? undefined : tone.icon} />
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
      <div className="flex items-center gap-1.5 border-t border-line p-2">
        <Link
          href={ADMIN_PROFILE_PATH}
          onClick={onNavigate}
          aria-current={onProfile ? "page" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-10 p-1.5 no-underline transition-colors",
            onProfile ? "bg-lavender-bg" : "hover:bg-bg",
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-lavender-bg text-[12px] font-extrabold text-lavender-fg"
          >
            {initialsOf(staff.name)}
          </span>
          <span className="min-w-0 leading-[1.2]">
            <span className="block truncate text-[13px] font-bold text-ink">{staff.name}</span>
            {/* ink-2, not ink-3: it also sits on the lavender fill while My profile is open (4.5:1 needed). */}
            <span className="block truncate text-[11.5px] font-semibold text-ink-2">{role} · My profile</span>
          </span>
        </Link>
        <Link
          href="/"
          onClick={onNavigate}
          aria-label="View storefront"
          title="View storefront"
          className="grid size-8 shrink-0 place-items-center rounded-9 text-ink-2 no-underline transition-colors hover:bg-bg hover:text-primary-link"
        >
          <Icon name="open_in_new" size={18} />
        </Link>
      </div>
    </div>
  );
}
