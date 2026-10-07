import type * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/icons/icon";
import { Badge, type BadgeProps } from "@/components/ui/badge";

export type StatusPillProps = Omit<BadgeProps, "asChild" | "children"> & {
  icon: IconName;
  /** Visible status text; the icon is decorative so colour is never the only signal. */
  label: React.ReactNode;
};

/** Status badge with a leading icon, e.g. license states (Active, Trial, Expiring soon...). Server-safe. */
export function StatusPill({ icon, label, size, className, ...props }: StatusPillProps) {
  return (
    <Badge data-slot="status-pill" size={size} className={cn("gap-1 pl-2", className)} {...props}>
      <Icon name={icon} size={size === "sm" ? 14 : 15} />
      {label}
    </Badge>
  );
}
