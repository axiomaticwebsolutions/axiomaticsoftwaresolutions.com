"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { BusinessSwitcher } from "@/components/account/business-switcher";
import { usePortal } from "@/components/account/portal-context";
import { initialsOf, navGroupsFor, navKeyForPath, PORTAL_PATHS } from "@/components/account/portal-nav";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { TEAM_ROLE_META } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/** POST /api/auth/sign-out, then the sign-in page (prototype: "Sign out -> session revoked, redirect to sign-in"). */
export function useSignOut() {
  const [busy, setBusy] = React.useState(false);
  const signOut = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch<void>("/api/auth/sign-out", { method: "POST" });
      window.location.assign(PORTAL_PATHS.signIn);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
      setBusy(false);
    }
  }, [busy]);
  return { signOut, busy };
}

/** A plain "Sign out" button (full-page portal notices). */
export function SignOutButton({ className, children = "Sign out" }: { className?: string; children?: React.ReactNode }) {
  const { signOut, busy } = useSignOut();
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      aria-busy={busy || undefined}
      className={cn("cursor-pointer aria-busy:cursor-progress", className)}
    >
      {children}
    </button>
  );
}

const ICON_BUTTON =
  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-9 border-0 bg-transparent text-ink-2 no-underline transition-colors hover:bg-slate-bg hover:text-ink aria-busy:cursor-progress";

export type PortalSidebarProps = {
  /** Called when a link is followed (the mobile drawer closes itself). */
  onNavigate?: () => void;
  /** The drawer's close button, shown at the end of the logo row. */
  closeButton?: React.ReactNode;
};

/**
 * Sidebar content (prototype aside): logo row, business switcher, grouped nav with badges and the user footer.
 * Rendered in the 256px sticky column from 1000px and in the mobile drawer below that.
 */
export function PortalSidebar({ onNavigate, closeButton }: PortalSidebarProps) {
  const pathname = usePathname();
  const { user, role, counts } = usePortal();
  const current = navKeyForPath(pathname);
  const groups = navGroupsFor(role, counts);
  const { signOut, busy } = useSignOut();
  // Unique per instance: the drawer can be open while the (hidden) desktop column is still in the DOM.
  const uid = React.useId();

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-4">
        {/* 35px tall like the prototype (an inline 30px mark plus the line box below it). */}
        <Link href={PORTAL_PATHS.store} aria-label="Axiomatic home" onClick={onNavigate} className="block h-[35px] flex-none rounded-9">
          <LogoMark size={30} />
        </Link>
        <span className="flex-1 text-[16px] font-extrabold tracking-[-0.02em]">Axiomatic</span>
        {closeButton}
      </div>
      <div className="relative px-3 pb-2">
        <BusinessSwitcher onNavigate={onNavigate} />
      </div>
      <nav aria-label="Account" className="grid flex-1 content-start gap-3.5 px-2.5 py-1">
        {groups.map((group) => {
          const headingId = `${uid}-${group.label.toLowerCase()}`;
          return (
            <div key={group.label}>
              <p
                id={headingId}
                className="m-0 px-2.5 pb-1 pt-1.5 text-[11px] font-extrabold uppercase tracking-[0.09em] text-ink-3"
              >
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
                          "flex items-center gap-2.5 rounded-10 px-2.5 py-2.5 text-[14px] font-bold no-underline transition-colors",
                          active ? "bg-lavender-bg text-lavender-fg" : "text-ink-soft hover:bg-hover-lavender hover:text-ink-soft",
                        )}
                      >
                        <Icon name={item.icon} size={20} />
                        <span className="flex-1">{item.label}</span>
                        {item.badge ? (
                          <>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "min-w-5 rounded-pill px-1.5 py-px text-center text-[11.5px] font-extrabold",
                                item.badge.tone === "warn" ? "bg-peach-bg text-peach-fg" : "bg-primary text-white",
                              )}
                            >
                              {item.badge.value}
                            </span>
                            <span className="sr-only">, {item.badge.label}</span>
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
      <div className="flex items-center gap-2.5 border-t border-line-subtle p-3">
        <span
          aria-hidden="true"
          className="grid size-[34px] flex-none place-items-center rounded-pill bg-lavender-bg text-[13px] font-extrabold text-lavender-fg"
        >
          {initialsOf(user.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[13.5px] font-extrabold">{user.name}</p>
          <p className="m-0 truncate text-[12px] font-semibold text-ink-2">{TEAM_ROLE_META[role].label}</p>
        </div>
        <Link href={PORTAL_PATHS.store} aria-label="Back to store" title="Back to store" onClick={onNavigate} className={ICON_BUTTON}>
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
