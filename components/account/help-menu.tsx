"use client";

import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { usePortal } from "@/components/account/portal-context";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ITEM = "text-ink no-underline hover:text-lavender-fg";

/**
 * Top-bar help (prototype: a "Help center" icon link to /support). A small menu: the help center, the installation
 * guide and, for roles that can raise tickets, "Raise a ticket".
 */
export function HelpMenu() {
  const { can } = usePortal();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Help"
          title="Help"
          className="grid size-[38px] shrink-0 cursor-pointer place-items-center rounded-10 border-0 bg-transparent text-ink-2 transition-colors hover:bg-slate-bg hover:text-ink data-[state=open]:bg-slate-bg"
        >
          <Icon name="help" size={21} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 leading-[normal]">
        <DropdownMenuItem asChild>
          <Link href={PORTAL_PATHS.helpCenter} className={ITEM}>
            <Icon name="help" size={19} />
            Help center
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={PORTAL_PATHS.installGuide} className={ITEM}>
            <Icon name="menu_book" size={19} />
            Installation guides
          </Link>
        </DropdownMenuItem>
        {can("tickets.create") ? (
          <DropdownMenuItem asChild>
            <Link href={PORTAL_PATHS.newTicket} className={ITEM}>
              <Icon name="support_agent" size={19} />
              Raise a ticket
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
