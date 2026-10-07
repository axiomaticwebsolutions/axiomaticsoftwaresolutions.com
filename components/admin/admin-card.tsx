import type * as React from "react";
import { cn } from "@/lib/utils";
import { ADMIN_CARD_CLASSES } from "./admin-card-classes";

export type AdminCardContentProps = {
  /** "AX-10262 · ₹23,598.82": 14px/800, in the body font (the prototype card title is never mono). */
  title: React.ReactNode;
  /** "Spice Route Kitchen · 7 Oct 2026": 12.5px/600, secondary ink. */
  subtitle?: React.ReactNode;
  /** Status pill on the right of the title. */
  badge?: React.ReactNode;
  className?: string;
};

/**
 * Content of an admin phone card below 760px (Admin Console.dc.html mobile rows; classes in admin-card-classes.ts).
 * Spans only, because the card itself is a button or a link. Server-safe.
 */
export function AdminCardContent({ title, subtitle, badge, className }: AdminCardContentProps) {
  return (
    <span className={cn(ADMIN_CARD_CLASSES.root, className)}>
      <span className={ADMIN_CARD_CLASSES.head}>
        <span className={ADMIN_CARD_CLASSES.title}>{title}</span>
        {badge ? <span className={ADMIN_CARD_CLASSES.badge}>{badge}</span> : null}
      </span>
      {subtitle ? <span className={ADMIN_CARD_CLASSES.subtitle}>{subtitle}</span> : null}
    </span>
  );
}
