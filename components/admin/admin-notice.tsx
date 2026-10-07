import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";

/** Classes of the notice's full-width buttons (primary look). */
export const NOTICE_BUTTON =
  "mt-5 block w-full cursor-pointer rounded-12 border-0 bg-primary p-[13px] text-center text-[15px] font-extrabold leading-[normal] text-white no-underline transition-colors hover:bg-primary-hover hover:text-white";

/**
 * Full-page card for states where the console cannot render (staff access not active, database unavailable): the
 * sign-in gate's 440px card with a lock tile. Server-safe.
 */
export function AdminNotice({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-bg-admin p-6 leading-[normal]">
      <div className="w-[min(440px,100%)] rounded-20 border border-line-alt bg-surface p-8 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
          <Icon name={icon} size={28} />
        </span>
        <h1 className="mb-0 mt-4 text-[22px] font-extrabold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
