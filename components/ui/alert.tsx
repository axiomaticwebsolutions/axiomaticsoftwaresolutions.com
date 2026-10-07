import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/icons/icon";

export const alertVariants = cva("flex gap-3 rounded-14 border px-4 py-3.5 text-[14.5px] leading-relaxed", {
  variants: {
    tone: {
      info: "border-blue-line bg-blue-bg text-blue-fg",
      success: "border-sage-line bg-sage-bg text-sage-fg",
      warning: "border-peach-line bg-peach-bg text-peach-fg",
      danger: "border-pink-line bg-pink-bg text-danger",
      neutral: "border-line bg-slate-bg text-ink-2",
      // Guest / signed-in notices on checkout (lavender soft).
      lavender: "border-lavender-line bg-lavender-soft text-lavender-fg",
    },
  },
  defaultVariants: { tone: "info" },
});

export type AlertTone = NonNullable<VariantProps<typeof alertVariants>["tone"]>;

const DEFAULT_ICON: Record<AlertTone, IconName> = {
  info: "info",
  success: "check_circle",
  warning: "warning",
  danger: "error",
  neutral: "info",
  lavender: "person",
};

export type AlertProps = React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /** Leading icon; defaults per tone. Pass null to hide it. */
    icon?: IconName | null;
  };

/**
 * Inline notice. danger uses role="alert" (announced immediately); other tones use role="status".
 * Override `role` (e.g. role="note" for static callouts) when the notice is not a live update. Server-safe.
 */
export function Alert({ className, tone, icon, role, children, ...props }: AlertProps) {
  const resolvedTone = tone ?? "info";
  const iconName = icon === undefined ? DEFAULT_ICON[resolvedTone] : icon;
  return (
    <div
      data-slot="alert"
      role={role ?? (resolvedTone === "danger" ? "alert" : "status")}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {iconName ? <Icon name={iconName} size={20} className="mt-0.5" /> : null}
      <div className="grid min-w-0 flex-1 gap-0.5">{children}</div>
    </div>
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("font-extrabold leading-snug", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("font-medium text-ink-body", className)} {...props} />;
}
