"use client";

import { usePathname } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { PortalSidebar } from "@/components/account/portal-sidebar";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** The portal breakpoint (lib/design/tokens.ts screens.portal): the sidebar is a column from here up. */
const PORTAL_QUERY = "(min-width: 62.5rem)";

const SQUARE =
  "grid shrink-0 cursor-pointer place-items-center rounded-10 border border-line-alt bg-surface text-ink transition-colors hover:border-line-input";

/**
 * Below 1000px the sidebar is a drawer (prototype: fixed, min(290px, 86vw), shadow, scrim). Radix Dialog via Sheet:
 * focus moves to the close button, Tab stays inside, Escape and the scrim close it, focus returns to the hamburger.
 * Following a link (or any route change) closes it, and so does widening the window past the breakpoint.
 */
export function MobilePortalNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpenAt(null), []);

  React.useEffect(() => {
    if (!open) return;
    const query = window.matchMedia(PORTAL_QUERY);
    const onChange = () => {
      if (query.matches) setOpenAt(null);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={(next) => setOpenAt(next ? pathname : null)}>
      <SheetTrigger asChild>
        <button type="button" aria-label="Open menu" className={cn(SQUARE, "size-[38px]", className)}>
          <Icon name="menu" size={21} />
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
        className="w-[min(290px,86vw)] max-w-none overflow-y-auto border-r-0 leading-[normal] portal:hidden"
      >
        <SheetTitle className="sr-only">Account navigation</SheetTitle>
        <PortalSidebar
          onNavigate={close}
          closeButton={
            <SheetClose asChild>
              <button ref={closeRef} type="button" aria-label="Close menu" className={cn(SQUARE, "size-9")}>
                <Icon name="close" size={20} />
              </button>
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
