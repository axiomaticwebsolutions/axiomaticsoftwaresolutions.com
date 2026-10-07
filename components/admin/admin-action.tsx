"use client";

import Link from "next/link";
import * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { useAdminOptional } from "@/components/admin/admin-context";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requiresLabel, type Permission } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import {
  ACTION_BASE as BASE,
  ACTION_SIZES as SIZES,
  ACTION_UNAVAILABLE as UNAVAILABLE,
  ACTION_VARIANTS as VARIANTS,
  type AdminActionSize,
  type AdminActionVariant,
} from "@/components/admin/action-styles";

export type { AdminActionSize, AdminActionVariant };

export type AdminActionProps = {
  children: React.ReactNode;
  /** Permission the action needs (lib/rbac.ts). Without it the action is disabled with "Requires Owner / ...". */
  perm?: Permission | null;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  variant?: AdminActionVariant;
  size?: AdminActionSize;
  icon?: IconName;
  /** A link instead of a button (next/link; `external` for a plain <a>, e.g. /orders/:id or a file). */
  href?: string;
  external?: boolean;
  /** Opens the link in a new tab (adds rel="noopener"). */
  newTab?: boolean;
  /** Shows a spinner and ignores clicks while an action runs. */
  busy?: boolean;
  type?: "button" | "submit";
  /** Unavailable for another reason (state, not role): disabled with this tooltip, e.g. "Only paid orders can be refunded". */
  disabledReason?: string;
  /** Tooltip when the role lacks `perm` (default requiresLabel(perm); bulk bars use "Not allowed for your role"). */
  deniedLabel?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  "aria-expanded"?: boolean;
  id?: string;
};

function swallow(event: React.MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * An admin console action (Admin Console.dc.html `btn()`): primary / default / danger in three sizes, gated by a
 * permission. A role without it still sees the action, disabled (aria-disabled, so it stays focusable) with the
 * "Requires Owner / Finance" tooltip on hover and keyboard focus. Cosmetic only: the API enforces the same PERMS.
 */
export const AdminAction = React.forwardRef<HTMLButtonElement, AdminActionProps>(function AdminAction(
  {
    children,
    perm,
    onClick,
    variant = "default",
    size = "md",
    icon,
    href,
    external = false,
    newTab = false,
    busy = false,
    type = "button",
    disabledReason,
    deniedLabel,
    className,
    ...aria
  },
  ref,
) {
  const admin = useAdminOptional();
  const allowed = !perm || !admin || admin.can(perm);
  const tooltip = !allowed && perm ? (deniedLabel ?? requiresLabel(perm)) : (disabledReason ?? null);
  const sizing = SIZES[size];
  const tone = VARIANTS[variant];
  const content = (
    <>
      {busy ? <Spinner tone={tone.spinner} size="sm" /> : icon ? <Icon name={icon} size={sizing.icon} /> : null}
      {children}
    </>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-disabled="true"
            onClick={swallow}
            className={cn(BASE, sizing.box, tone.look, UNAVAILABLE, className)}
            {...aria}
          >
            {content}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  const classes = cn(BASE, sizing.box, tone.look, tone.hover, className);
  if (href) {
    const rel = newTab ? "noopener noreferrer" : undefined;
    const target = newTab ? "_blank" : undefined;
    return external || newTab ? (
      <a href={href} target={target} rel={rel} className={classes} {...aria}>
        {content}
      </a>
    ) : (
      <Link href={href} className={classes} {...aria}>
        {content}
      </Link>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      onClick={busy ? swallow : onClick}
      aria-busy={busy || undefined}
      className={classes}
      {...aria}
    >
      {content}
    </button>
  );
});
