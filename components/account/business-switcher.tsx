"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { usePortal } from "@/components/account/portal-context";
import { devicesLabel, initialsOf, locationsSummary, PORTAL_PATHS } from "@/components/account/portal-nav";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";

const OVERLINE = "px-2 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink-2";
const MENU_LINK =
  "block rounded-9 p-2 font-bold text-primary-link no-underline transition-colors hover:bg-lavender-soft hover:text-primary-link-hover";

/**
 * Business switcher (prototype sidebar button + dropdown): the active business with its location count; the popover
 * lists the locations with their active devices, "Business details" and (owners) "Manage team". When the user belongs
 * to several businesses it also lists them: choosing one sets the server-side active account
 * (POST /api/me/active-account) and reloads the overview. Escape and outside clicks close it (Radix Popover).
 */
export function BusinessSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { account, accounts, locations, can } = usePortal();
  const [open, setOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState<string | null>(null);

  const follow = () => {
    setOpen(false);
    onNavigate?.();
  };

  async function switchTo(id: string) {
    if (switching || id === account.id) return;
    setSwitching(id);
    try {
      await apiFetch<unknown>("/api/me/active-account", { method: "POST", body: { accountId: id } });
      // A full load: every view, cache and badge belongs to the other business now.
      window.location.assign(PORTAL_PATHS.overview);
    } catch (error) {
      setSwitching(null);
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-12 border border-line-alt bg-bg px-2.5 py-[9px] text-left transition-colors hover:border-line-input data-[state=open]:border-line-input"
        >
          <span
            aria-hidden="true"
            className="grid size-[30px] flex-none place-items-center rounded-9 bg-sage-bg text-[13px] font-extrabold text-sage-fg"
          >
            {initialsOf(account.legalName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-extrabold">{account.legalName}</span>
            <span className="block text-[12px] font-semibold text-ink-2">{locationsSummary(locations.length)}</span>
          </span>
          <Icon name="unfold_more" size={18} className="text-ink-2" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Business"
        // The prototype dropdown starts 54px below the 55px button, overlapping its border by 1px.
        sideOffset={-1}
        className="w-(--radix-popover-trigger-width) min-w-[220px] rounded-14 border-line-alt p-2 text-[13.5px] leading-[normal]"
      >
        {accounts.length > 1 ? (
          <>
            <p className={cn("m-0", OVERLINE)}>Businesses</p>
            <ul className="m-0 grid list-none gap-px p-0">
              {accounts.map((a) => {
                const current = a.id === account.id;
                return (
                  <li key={a.id} className="grid">
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      aria-busy={switching === a.id || undefined}
                      disabled={Boolean(switching) && switching !== a.id}
                      onClick={() => void switchTo(a.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-9 border-0 bg-transparent p-2 text-left font-semibold transition-colors",
                        "hover:bg-lavender-soft disabled:cursor-not-allowed disabled:opacity-55 aria-[current=true]:cursor-default aria-[current=true]:hover:bg-transparent",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="grid size-6 flex-none place-items-center rounded-6 bg-sage-bg text-[10.5px] font-extrabold text-sage-fg"
                      >
                        {initialsOf(a.legalName)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{a.legalName}</span>
                      {switching === a.id ? <Spinner size="sm" /> : null}
                      {current ? <Icon name="check" size={18} className="text-primary" label="Current business" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mx-0 my-1.5 h-px bg-line-subtle" />
          </>
        ) : null}
        <p className={cn("m-0", OVERLINE)}>Locations</p>
        {locations.length === 0 ? (
          <p className="m-0 p-2 font-semibold text-ink-2">No locations yet</p>
        ) : (
          <ul className="m-0 grid max-h-[240px] list-none overflow-y-auto p-0">
            {locations.map((l) => (
              <li key={l.id} className="flex items-center gap-2 rounded-9 p-2 font-semibold">
                <Icon name="storefront" size={18} className="text-ink-2" />
                <span className="min-w-0 flex-1">{l.name}</span>
                <span className="ml-auto shrink-0 text-[12px] text-ink-2">{devicesLabel(l.activeDevices)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mx-0 my-1.5 h-px bg-line-subtle" />
        <Link href={PORTAL_PATHS.billing} onClick={follow} className={MENU_LINK}>
          Business details
        </Link>
        {can("team.manage") ? (
          <Link href={PORTAL_PATHS.team} onClick={follow} className={MENU_LINK}>
            Manage team
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
