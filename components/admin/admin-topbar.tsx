"use client";

import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { initialsOf } from "@/components/admin/admin-nav";
import { MobileAdminNav } from "@/components/admin/mobile-admin-nav";
import { ModuleSearch } from "@/components/admin/module-search";
import { useStaffSignOut } from "@/components/admin/sign-out";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ADMIN_PROFILE_PATH, PROFILE_COPY } from "@/lib/admin/profile/model";
import { STAFF_ROLE_LABELS } from "@/lib/rbac";

/**
 * The signed-in staff member (prototype user chip) as a menu: name, email and role, View storefront, My profile
 * (two-step sign-in, password, sessions; decisions.md 2026-10-08) and Sign out. Radix menu: Enter, Space or arrow
 * keys open it and move between the items.
 */
function StaffMenu() {
  const { staff } = useAdmin();
  const { signOut, busy } = useStaffSignOut();
  const role = STAFF_ROLE_LABELS[staff.role];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${staff.name}, ${role}: account menu`}
          aria-busy={busy || undefined}
          className="flex shrink-0 cursor-pointer items-center gap-2 rounded-9 border-0 bg-transparent p-0.5 text-left text-[13px] font-bold leading-[normal] text-ink aria-busy:cursor-progress cards:pr-1.5"
        >
          <span
            aria-hidden="true"
            className="grid size-[30px] shrink-0 place-items-center rounded-pill bg-lavender-bg text-[11.5px] font-extrabold text-lavender-fg"
          >
            {initialsOf(staff.name)}
          </span>
          <span aria-hidden="true" className="hidden min-w-0 cards:block">
            <span className="block max-w-[180px] truncate">{staff.name}</span>
            <span className="block text-[11.5px] font-semibold text-ink-2">{role}</span>
          </span>
          <Icon name="expand_more" size={18} className="hidden text-ink-3 cards:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 leading-[normal]">
        <div className="px-2.5 pb-2 pt-1.5">
          <p className="m-0 truncate text-[14px] font-extrabold">{staff.name}</p>
          <p className="m-0 mt-0.5 truncate text-[12.5px] font-semibold text-ink-2">{staff.email}</p>
          <p className="m-0 mt-1.5 text-[12px] font-bold text-lavender-fg">{role}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/" className="no-underline">
            <Icon name="open_in_new" size={18} />
            View storefront
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={ADMIN_PROFILE_PATH} className="no-underline">
            <Icon name="person" size={18} />
            {PROFILE_COPY.menuLabel}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
        >
          <Icon name="logout" size={18} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Admin top bar (prototype): 56px, sticky, white with a bottom border. Hamburger below 1040px, module search
 * (max 460px; Ctrl K / "/"), the "Test mode" pill while payments run in test mode (computed on the server; the key is
 * never sent) and the signed-in staff member (initials; name and role from 760px) with the account menu (My profile,
 * Sign out).
 */
export function AdminTopbar() {
  const { testMode } = useAdmin();
  return (
    <header className="sticky top-0 z-30 border-b border-line-alt bg-surface">
      <div className="flex h-14 items-center gap-2.5 px-[clamp(12px,2vw,24px)]">
        <MobileAdminNav className="admin:hidden" />
        <ModuleSearch />
        <span className="hidden flex-1 cards:block" />
        {testMode ? (
          <span className="shrink-0 whitespace-nowrap rounded-pill bg-peach-bg px-2.5 py-1 text-[12px] font-extrabold leading-[normal] text-peach-fg">
            Test mode
          </span>
        ) : null}
        <StaffMenu />
      </div>
    </header>
  );
}
