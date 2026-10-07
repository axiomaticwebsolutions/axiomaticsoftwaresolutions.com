"use client";

import * as React from "react";
import type { IconName } from "@/components/icons/icon";
import { AdminAction, type AdminActionSize, type AdminActionVariant } from "@/components/admin/admin-action";
import { useAdminOptional } from "@/components/admin/admin-context";
import { ConfirmDialog, type ConfirmTone } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/sonner";
import { DESTRUCTIVE_ACTIONS, validateReason, type DestructiveActionKey } from "@/lib/rbac";

type ActionCopy = {
  /** Trigger button text. */
  trigger: string;
  icon: IconName;
  variant: AdminActionVariant;
  tone: ConfirmTone;
  /** Dialog title from the target label (prototype copy). */
  title: (target: string) => string;
};

/** Trigger, icon, tone and title per action, from the prototype's ask() dialogs and drawer buttons. */
export const DESTRUCTIVE_COPY: Record<DestructiveActionKey, ActionCopy> = {
  "orders.refund": { trigger: "Issue refund", icon: "currency_exchange", variant: "danger", tone: "danger", title: (t) => `Refund ${t}?` },
  "licenses.revoke": { trigger: "Revoke", icon: "block", variant: "danger", tone: "danger", title: (t) => `Revoke ${t} permanently?` },
  "licenses.suspend": { trigger: "Suspend", icon: "pause_circle", variant: "default", tone: "warning", title: (t) => `Suspend ${t}?` },
  "licenses.reinstate": { trigger: "Reinstate", icon: "play_circle", variant: "primary", tone: "success", title: (t) => `Reinstate ${t}?` },
  "licenses.extend": { trigger: "Extend", icon: "more_time", variant: "default", tone: "primary", title: (t) => `Extend ${t}?` },
  "licenses.reset_devices": { trigger: "Reset devices", icon: "restart_alt", variant: "default", tone: "warning", title: (t) => `Reset all devices on ${t}?` },
  "licenses.deactivate_device": { trigger: "Deactivate", icon: "computer", variant: "default", tone: "warning", title: (t) => `Deactivate ${t}?` },
  "licenses.issue_manual": { trigger: "Issue license", icon: "key", variant: "primary", tone: "primary", title: (t) => `Issue a license to ${t}?` },
  "plans.archive": { trigger: "Archive plan", icon: "archive", variant: "danger", tone: "danger", title: (t) => `Archive ${t}?` },
  "plans.restore": { trigger: "Restore", icon: "archive", variant: "default", tone: "primary", title: (t) => `Restore ${t}?` },
  "products.hide": { trigger: "Hide", icon: "visibility_off", variant: "default", tone: "primary", title: (t) => `Hide ${t}?` },
  "products.publish": { trigger: "Publish", icon: "visibility", variant: "primary", tone: "primary", title: (t) => `Publish ${t}?` },
  "categories.delete": { trigger: "Delete category", icon: "delete", variant: "danger", tone: "danger", title: (t) => `Delete ${t}?` },
  "releases.delete": { trigger: "Delete draft", icon: "delete", variant: "danger", tone: "danger", title: (t) => `Delete the draft ${t}?` },
  "releases.remove_installer": { trigger: "Remove", icon: "delete", variant: "danger", tone: "danger", title: (t) => `Remove ${t}?` },
  "coupons.delete": { trigger: "Delete", icon: "delete", variant: "danger", tone: "danger", title: (t) => `Delete ${t}?` },
  "faqs.delete": { trigger: "Delete", icon: "delete", variant: "danger", tone: "danger", title: () => "Delete this FAQ?" },
  "staff.change_role": { trigger: "Change role", icon: "badge", variant: "default", tone: "primary", title: (t) => `Change the role of ${t}?` },
  "staff.deactivate": { trigger: "Deactivate", icon: "person_off", variant: "danger", tone: "danger", title: (t) => `Deactivate ${t}?` },
  "staff.reactivate": { trigger: "Reactivate", icon: "person_off", variant: "default", tone: "primary", title: (t) => `Reactivate ${t}?` },
  "staff.revoke_invite": { trigger: "Revoke invitation", icon: "person_off", variant: "danger", tone: "danger", title: (t) => `Revoke the invitation for ${t}?` },
};

export type DestructiveConfirmInput = {
  /** Trimmed reason (always present: every DESTRUCTIVE_ACTIONS rule requires one). */
  reason: string;
  /** The typed id, for actions that require it (send it as `confirmId`). */
  confirmId?: string;
};

export type DestructiveActionProps = {
  /** Rule in lib/rbac.ts DESTRUCTIVE_ACTIONS: permission, reason and typed-id requirements, confirm label. */
  actionKey: DestructiveActionKey;
  /** The id to type for refund, revoke and coupon delete (order id, license id, coupon code). */
  targetId: string;
  /** How the target reads in the title ("LIC-24017", "Annual · Medical Store Billing"); default targetId. */
  targetLabel?: string;
  /** What happens if the user confirms (dialog body). */
  consequence: React.ReactNode;
  /** Runs the action (an API call). A thrown error's message is shown in the dialog, which stays open. */
  onConfirm: (input: DestructiveConfirmInput) => Promise<unknown> | unknown;
  /** Toast after success, e.g. "License suspended". */
  successMessage?: string;
  /** Overrides of the prototype copy. */
  title?: React.ReactNode;
  confirmLabel?: string;
  triggerLabel?: React.ReactNode;
  icon?: IconName;
  variant?: AdminActionVariant;
  tone?: ConfirmTone;
  size?: AdminActionSize;
  /** The action does not apply right now (state, not role): disabled trigger with this tooltip. */
  disabledReason?: string;
  /** Controlled dialog (open it from a menu or the bulk bar); with `hideTrigger` no button is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  className?: string;
};

/**
 * A destructive or audited admin action (decisions.md Phase 6): the trigger button is gated by the rule's permission
 * (disabled with "Requires ..." when the role lacks it); confirming needs a reason (4-500 characters, saved to the
 * audit log) and, for refund / revoke / coupon delete, the typed id. The server checks all of it again
 * (lib/admin/destructive.ts) and writes exactly one AuditLog row.
 */
export function DestructiveAction({
  actionKey,
  targetId,
  targetLabel,
  consequence,
  onConfirm,
  successMessage,
  title,
  confirmLabel,
  triggerLabel,
  icon,
  variant,
  tone,
  size = "sm",
  disabledReason,
  open: openProp,
  onOpenChange,
  hideTrigger = false,
  className,
}: DestructiveActionProps) {
  const rule = DESTRUCTIVE_ACTIONS[actionKey];
  const copy = DESTRUCTIVE_COPY[actionKey];
  const admin = useAdminOptional();
  // A controlled dialog never opens for a role without the permission (the API would refuse anyway).
  const allowed = !admin || admin.can(rule.perm);
  const [innerOpen, setInnerOpen] = React.useState(false);
  const open = (openProp ?? innerOpen) && allowed;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const typed = rule.typedId ? targetId : undefined;

  async function confirm({ reason }: { reason: string }) {
    const checked = validateReason(reason);
    if (!checked.ok) throw new Error(checked.message);
    await onConfirm({ reason: checked.reason, ...(typed !== undefined ? { confirmId: typed } : {}) });
    if (successMessage) toast.success(successMessage);
  }

  return (
    <>
      {hideTrigger ? null : (
        <AdminAction
          perm={rule.perm}
          variant={variant ?? copy.variant}
          size={size}
          icon={icon ?? copy.icon}
          disabledReason={disabledReason}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className={className}
        >
          {triggerLabel ?? copy.trigger}
        </AdminAction>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title ?? copy.title(targetLabel ?? targetId)}
        description={consequence}
        confirmLabel={confirmLabel ?? rule.label}
        tone={tone ?? copy.tone}
        icon={icon ?? copy.icon}
        requireReason={rule.reason}
        confirmText={typed}
        onConfirm={confirm}
      />
    </>
  );
}
