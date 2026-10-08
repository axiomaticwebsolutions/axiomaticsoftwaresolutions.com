"use client";

import { usePathname } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** The admin breakpoint (lib/design/tokens.ts screens.admin, 1040px): the sidebar is a column from here up. */
export const ADMIN_NAV_QUERY = "(min-width: 65rem)";

/**
 * Below 1040px the sidebar is a drawer (prototype: fixed, min(270px, 86vw), shadow, scrim). Radix Dialog via Sheet:
 * focus moves to the close button, Tab stays inside, Escape and the scrim close it, focus returns to the hamburger.
 * Following a link (or any route change) closes it, and so does widening the window past the breakpoint.
 */
export function MobileAdminNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpenAt(null), []);

  React.useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(ADMIN_NAV_QUERY);
    const onChange = () => {
      if (query.matches) setOpenAt(null);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={(next) => setOpenAt(next ? pathname : null)}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className={cn(
            "grid size-9 shrink-0 cursor-pointer place-items-center rounded-9 border border-line-alt bg-surface text-ink transition-colors hover:border-line-input",
            className,
          )}
        >
          <Icon name="menu" size={20} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        showClose={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        className="w-[min(270px,86vw)] max-w-none overflow-hidden border-r-0 bg-surface leading-[normal] admin:hidden"
      >
        <SheetTitle className="sr-only">Admin navigation</SheetTitle>
        <AdminSidebar
          onNavigate={close}
          closeButton={
            <SheetClose asChild>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close menu"
                className="grid size-[34px] shrink-0 cursor-pointer place-items-center rounded-9 border border-line-alt bg-surface text-ink transition-colors hover:border-line-input hover:bg-bg"
              >
                <Icon name="close" size={20} />
              </button>
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
