"use client";

import * as React from "react";
import { usePortal } from "@/components/account/portal-context";
import { teamRequiresLabel } from "@/components/account/portal-nav";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TeamPermission } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/** Inactive look for elements without their own aria-disabled styles (exempt from contrast rules as inactive UI). */
const DISABLED_LOOK = "cursor-not-allowed opacity-55";

type DisableableProps = {
  "aria-disabled"?: boolean | "true" | "false";
  onClick?: (event: React.MouseEvent) => void;
  href?: unknown;
  className?: string;
};

function swallow(event: React.MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export type DisabledActionProps = Omit<ButtonProps, "disabled" | "onClick" | "loading" | "loadingText"> & {
  /** The team permission the action needs; the tooltip names the roles that hold it ("Requires Owner or Billing admin"). */
  perm: TeamPermission;
  /** Tooltip text instead of the "Requires ..." label. */
  reason?: string;
};

/**
 * An action the member's team role lacks (decisions.md Phase 5): it stays visible and focusable but does nothing,
 * with aria-disabled and a tooltip "Requires {roles}" on hover and keyboard focus (a natively disabled button would
 * get neither). Renders a Button; with `asChild` it disables the single child element instead (a styled button keeps
 * its element; a link becomes a focusable span with the same classes, since a disabled link has no href).
 */
export function DisabledAction({ perm, reason, asChild = false, children, ...props }: DisabledActionProps) {
  const label = reason ?? teamRequiresLabel(perm);
  let trigger: React.ReactElement;
  if (asChild && React.isValidElement<DisableableProps & { children?: React.ReactNode }>(children)) {
    trigger =
      typeof children.props.href === "string" ? (
        // A link (next/link needs its href) becomes a focusable, disabled link-like span with the same look.
        <span role="link" aria-disabled="true" tabIndex={0} className={cn(children.props.className, DISABLED_LOOK)}>
          {children.props.children}
        </span>
      ) : (
        React.cloneElement(children, {
          "aria-disabled": "true",
          onClick: swallow,
          className: cn(children.props.className, DISABLED_LOOK),
        })
      );
  } else {
    trigger = (
      <Button type="button" {...props} aria-disabled="true" onClick={swallow}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Renders `children` (one action element) when the member's role holds `perm`, else the same element disabled with
 * the "Requires ..." tooltip. Cosmetic only: the API enforces the same TEAM_PERMS.
 */
export function PermissionAction({ perm, reason, children }: { perm: TeamPermission; reason?: string; children: React.ReactElement }) {
  const { can } = usePortal();
  if (can(perm)) return children;
  return (
    <DisabledAction perm={perm} reason={reason} asChild>
      {children}
    </DisabledAction>
  );
}
