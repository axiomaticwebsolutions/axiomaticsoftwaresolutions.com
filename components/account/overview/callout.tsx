import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import type { Tone } from "@/lib/design/tokens";
import { cn } from "@/lib/utils";
import { TONE_CLASSES } from "./tones";

/** Primary call to action of a callout (prototype: 8x14, radius 10, 13.5px/700, no wrap). */
export const CALLOUT_CTA_CLASS =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-10 border-0 bg-primary px-3.5 py-2 text-[13.5px] font-bold leading-[normal] text-white no-underline transition-colors hover:bg-primary-hover hover:text-white";

export type PortalCalloutProps = {
  tone: Tone;
  icon: IconName;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** Extra line after the body (e.g. "2 more licenses also end within 60 days."). */
  extra?: React.ReactNode;
  /** Right-hand actions (CTA, dismiss). */
  actions?: React.ReactNode;
  /** Defaults to "status" as in the prototype's alerts. */
  role?: "status" | "alert" | "none";
  className?: string;
} & Omit<React.ComponentProps<"div">, "title" | "role">;

/**
 * Overview alert (Customer Portal.dc.html): tinted card radius 14 with the tone's line, a 22px icon, bold title and
 * body on one line of text, and a primary CTA on the right. Below 480px the actions move under the text (the
 * prototype squeezed them beside it). Server-safe; also used by the Software page's trial notices.
 */
export function PortalCallout({ tone, icon, title, body, extra, actions, role = "status", className, ...props }: PortalCalloutProps) {
  const t = TONE_CLASSES[tone];
  return (
    <div
      role={role === "none" ? undefined : role}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-14 border px-3.5 py-3",
        "max-[29.99rem]:grid-cols-[auto_minmax(0,1fr)] max-[29.99rem]:items-start",
        t.callout,
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={22} className={t.fg} />
      <div className="min-w-0">
        <span className="text-[14.5px] font-extrabold">{title}</span>
        {body ? <> <span className="text-[14px] text-ink-soft">{body}</span></> : null}
        {extra ? <span className="mt-0.5 block text-[13px] font-semibold text-ink-soft">{extra}</span> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 max-[29.99rem]:col-start-2 max-[29.99rem]:justify-self-start">{actions}</div>
      ) : null}
    </div>
  );
}
