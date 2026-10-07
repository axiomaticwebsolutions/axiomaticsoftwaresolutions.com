"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { accountDestination, ACCOUNT_MENU_COPY, firstName, initials, isPrivatePath } from "@/components/auth/account-menu-model";
import { markSignedOut, useSession } from "@/components/auth/session-store";
import { Icon } from "@/components/icons/icon";
import { STORE_PATHS } from "@/components/store/active-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/**
 * POST /api/auth/sign-out, then leave private pages or tell the visitor on public ones. Errors become a toast.
 * Resolves true when signed out.
 */
function useSignOut(onDone?: () => void) {
  const pathname = usePathname() ?? "/";
  const [busy, setBusy] = React.useState(false);
  const signOut = React.useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await apiFetch<void>("/api/auth/sign-out", { method: "POST" });
      if (isPrivatePath(pathname)) {
        window.location.assign("/");
        return true;
      }
      markSignedOut();
      onDone?.();
      toast.success(ACCOUNT_MENU_COPY.signedOut);
      return true;
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, pathname, onDone]);
  return { signOut, busy };
}

/** The header's "Sign in" link (the server-rendered default until the session is known). */
const SIGN_IN_LINK =
  "rounded-12 px-3.5 py-2.5 text-[15px] font-bold leading-[21px] text-ink no-underline transition-colors hover:bg-lavender-bg";

/** The mobile panel's outlined cell (same look as the panel's former "Sign in" link). */
const MOBILE_CELL =
  "grid place-items-center rounded-12 border border-line-input p-[13px] text-center text-ink no-underline transition-colors hover:border-primary";

export type AccountMenuProps = {
  /** header = the bar at 960px and up; mobile = the cell next to "Request a demo" in the mobile panel. */
  variant?: "header" | "mobile";
  /** Called when a link is followed or the user signs out (the mobile panel closes itself). */
  onNavigate?: () => void;
};

/**
 * Header account state (new; the prototype header only has "Sign in"). Pages stay static: the session is read after
 * mount (components/auth/session-store.ts). Signed out (and until the answer arrives): the "Sign in" link. Signed in:
 * at 960px and up a menu with the name and email, "My account" (/account) or "Admin console" (/admin) for staff, and
 * "Sign out"; in the mobile panel the same links as plain buttons.
 */
export function AccountMenu({ variant = "header", onNavigate }: AccountMenuProps) {
  const session = useSession();
  const signInRef = React.useRef<HTMLAnchorElement>(null);
  const restoreFocus = React.useRef(false);
  const { signOut, busy } = useSignOut(onNavigate);

  // The menu trigger is gone after signing out: keyboard focus moves to the "Sign in" link that replaces it.
  React.useEffect(() => {
    if (session.status !== "signed-in" && restoreFocus.current) {
      restoreFocus.current = false;
      signInRef.current?.focus();
    }
  }, [session.status]);

  if (session.status !== "signed-in") {
    return (
      <Link ref={signInRef} href={STORE_PATHS.signIn} onClick={onNavigate} className={variant === "header" ? SIGN_IN_LINK : MOBILE_CELL}>
        {ACCOUNT_MENU_COPY.signIn}
      </Link>
    );
  }

  const { user } = session;
  const destination = accountDestination(user);

  if (variant === "mobile") {
    return (
      <div className="contents">
        <Link href={destination.href} onClick={onNavigate} className={MOBILE_CELL}>
          {destination.label}
        </Link>
        <div className="order-1 col-span-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pt-1 text-[14px] font-semibold text-ink-2">
          <span className="min-w-0 truncate">
            {ACCOUNT_MENU_COPY.signedInAs} <span className="text-ink">{user.name}</span>
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            aria-busy={busy || undefined}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-8 border-0 bg-transparent px-1 py-1 font-bold text-primary-link hover:text-primary-link-hover aria-busy:cursor-progress"
          >
            <Icon name="logout" size={18} />
            {ACCOUNT_MENU_COPY.signOut}
          </button>
        </div>
      </div>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ACCOUNT_MENU_COPY.menuLabel(firstName(user.name) || user.name)}
          className="flex h-[41px] cursor-pointer items-center gap-2 rounded-12 border-0 bg-transparent pl-1.5 pr-2 text-[15px] font-bold leading-[21px] text-ink transition-colors hover:bg-lavender-bg data-[state=open]:bg-lavender-bg"
        >
          <span aria-hidden="true" className="grid size-7 place-items-center rounded-pill bg-primary text-[12px] font-extrabold text-white">
            {initials(user.name)}
          </span>
          {/* The name shows from 1100px; narrower bars keep the avatar only (the button is still named after the user). */}
          <span className="hidden max-w-[7.5rem] truncate min-[68.75rem]:inline">{firstName(user.name) || user.name}</span>
          <Icon name="expand_more" size={20} className="text-ink-2" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="grid gap-0.5 px-2.5 pb-2 pt-1.5">
          <p className="m-0 truncate text-[14.5px] font-extrabold text-ink">{user.name}</p>
          <p className="m-0 truncate text-[13px] font-semibold text-ink-2">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={destination.href} className="text-ink no-underline">
            <Icon name={user.kind === "STAFF" ? "space_dashboard" : "person"} size={19} />
            {destination.label}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            restoreFocus.current = true;
            void signOut().then((ok) => {
              if (!ok) restoreFocus.current = false;
            });
          }}
        >
          <Icon name="logout" size={19} />
          {ACCOUNT_MENU_COPY.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
