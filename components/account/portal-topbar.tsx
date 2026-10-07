"use client";

import Link from "next/link";
import { DisabledAction } from "@/components/account/disabled-action";
import { GlobalSearch } from "@/components/account/global-search";
import { HelpMenu } from "@/components/account/help-menu";
import { MobilePortalNav } from "@/components/account/mobile-portal-nav";
import { NotificationBell } from "@/components/account/notification-bell";
import { usePortal } from "@/components/account/portal-context";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { cn } from "@/lib/utils";

const BUY =
  "hidden whitespace-nowrap rounded-10 bg-primary px-3.5 py-[9px] text-[13.5px] font-bold leading-[normal] text-white no-underline transition-colors hover:bg-primary-hover hover:text-white min-[45rem]:inline-block";

/**
 * Portal top bar (prototype): 58px, sticky, translucent white with a 10px blur and a bottom border. Hamburger below
 * 1000px, global search (max 520px; Ctrl K hint from 720px), help menu, notification bell and "Buy software" (from
 * 720px; disabled with "Requires Owner or Billing admin" for roles that cannot buy).
 */
export function PortalTopbar() {
  const { can } = usePortal();
  return (
    <header className="sticky top-0 z-30 border-b border-line-alt bg-surface/94 backdrop-blur-[10px]">
      <div className="flex h-[58px] items-center gap-3 px-[clamp(14px,2.4vw,28px)]">
        <MobilePortalNav className="portal:hidden" />
        <GlobalSearch />
        {/* The prototype splits the free space between the field and this spacer; phones give it all to the field. */}
        <span className="hidden flex-1 min-[45rem]:block" />
        <HelpMenu />
        <NotificationBell />
        {can("purchases") ? (
          <Link href={PORTAL_PATHS.catalog} className={BUY}>
            Buy software
          </Link>
        ) : (
          <DisabledAction perm="purchases" asChild>
            <button type="button" className={cn(BUY, "border-0")}>
              Buy software
            </button>
          </DisabledAction>
        )}
      </div>
    </header>
  );
}
