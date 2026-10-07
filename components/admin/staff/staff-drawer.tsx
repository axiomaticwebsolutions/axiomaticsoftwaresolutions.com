"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer, type AdminField } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toastInviteOutcome, type StaffInviteResponse } from "./invite-staff";
import type { StaffRole } from "@/generated/prisma/enums";
import { formatAdminDateTimeLong, relativeAgo } from "@/lib/admin/audit/format";
import {
  permissionCountLabel,
  requiresTwoStep,
  roleLabel,
  STAFF_COPY,
  staffDisplayName,
  staffStatusLabel,
  twoStepLabel,
  type StaffRow,
} from "@/lib/admin/staff/model";
import { apiFetch } from "@/lib/client/api";
import { formatDateIST } from "@/lib/dates";
import { STAFF_ROLES } from "@/lib/rbac";

export type StaffDrawerProps = {
  /** The open staff member, or null when the id in the URL matches nobody. */
  row: StaffRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closes the drawer (after revoking an invitation the record is gone). */
  close: () => void;
  /** Server render time (relative "Last active" without a hydration mismatch). */
  now: string;
};

const path = (id: string, rest = "") => `/api/admin/staff/${encodeURIComponent(id)}${rest}`;

/**
 * Staff drawer (prototype mods.staff detail): role badge and email, facts (role, status, two-step, last active),
 * "Change role" rows with Assign (reason dialog), the invitation (resend / revoke) for invited people, and
 * Deactivate / Reactivate in the footer. Nothing is offered on your own record.
 */
export function StaffDrawer({ row, open, onOpenChange, close, now }: StaffDrawerProps) {
  const router = useRouter();
  const admin = useAdmin();
  const [roleTarget, setRoleTarget] = React.useState<StaffRole | null>(null);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [resending, setResending] = React.useState(false);

  if (!row) {
    return (
      <AdminDrawer open={open} onOpenChange={onOpenChange} kind={STAFF_COPY.drawerKind} title={STAFF_COPY.caption} error={STAFF_COPY.notFound} />
    );
  }

  const name = staffDisplayName(row);
  const self = row.id === admin.staff.id;
  const invited = row.status === "invited";

  const fields: AdminField[] = [
    { label: STAFF_COPY.fields.role, value: roleLabel(row.role) },
    { label: STAFF_COPY.fields.status, value: staffStatusLabel(row) },
    { label: STAFF_COPY.fields.twoStep, value: twoStepLabel(row) },
    {
      label: STAFF_COPY.fields.lastActive,
      value: row.lastActiveAt ? (
        <time dateTime={row.lastActiveAt} title={formatAdminDateTimeLong(row.lastActiveAt)}>
          {relativeAgo(row.lastActiveAt, now)}
        </time>
      ) : null,
    },
    { label: STAFF_COPY.fields.added, value: formatDateIST(new Date(row.createdAt)) },
  ];

  async function resend() {
    if (!row || resending) return;
    setResending(true);
    try {
      const result = await apiFetch<StaffInviteResponse>(path(row.id, "/resend-invite"), { method: "POST", body: {} });
      toastInviteOutcome(result, STAFF_COPY.resent(row.email));
      router.refresh();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setResending(false);
    }
  }

  const roleRows = (
    <SectionRows aria-label={STAFF_COPY.changeRole}>
      {STAFF_ROLES.map((role) => (
        <SectionRow
          key={role}
          title={roleLabel(role)}
          detail={permissionCountLabel(role)}
          status={row.role === role ? STAFF_COPY.current : undefined}
          tone="lavender"
          action={
            self || row.role === role ? null : (
              <AdminAction
                perm="staff.manage"
                size="xs"
                onClick={() => setRoleTarget(role)}
                aria-haspopup="dialog"
                aria-label={`${STAFF_COPY.assign} ${roleLabel(role)}`}
              >
                {STAFF_COPY.assign}
              </AdminAction>
            )
          }
        />
      ))}
    </SectionRows>
  );

  const invitation = row.invite ? (
    <SectionRows aria-label={STAFF_COPY.invitationSection}>
      <SectionRow
        title={STAFF_COPY.inviteSent(formatAdminDateTimeLong(row.invite.sentAt))}
        detail={(row.invite.expired ? STAFF_COPY.inviteExpired : STAFF_COPY.inviteExpires)(formatAdminDateTimeLong(row.invite.expiresAt))}
        status={row.invite.expired ? staffStatusLabel(row) : undefined}
        tone="peach"
      />
    </SectionRows>
  ) : null;

  const sections = [
    { id: "role", title: STAFF_COPY.changeRole, content: roleRows },
    ...(invited ? [{ id: "invite", title: STAFF_COPY.invitationSection, content: invitation, empty: STAFF_COPY.noWorkingLink }] : []),
  ];

  const footer = self ? null : invited ? (
    <>
      <AdminAction perm="staff.manage" size="sm" variant="primary" icon="send" busy={resending} onClick={resend}>
        {STAFF_COPY.resend}
      </AdminAction>
      <AdminAction perm="staff.manage" size="sm" variant="danger" icon="cancel" onClick={() => setRevokeOpen(true)} aria-haspopup="dialog">
        {STAFF_COPY.revoke}
      </AdminAction>
    </>
  ) : row.status === "deactivated" ? (
    <DestructiveAction
      actionKey="staff.reactivate"
      targetId={row.id}
      title={STAFF_COPY.reactivateTitle(name)}
      consequence={STAFF_COPY.reactivateConsequence}
      successMessage={STAFF_COPY.staffUpdated}
      onConfirm={async ({ reason }) => {
        await apiFetch(path(row.id, "/reactivate"), { method: "POST", body: { reason } });
        router.refresh();
      }}
    />
  ) : (
    <DestructiveAction
      actionKey="staff.deactivate"
      targetId={row.id}
      title={STAFF_COPY.deactivateTitle(name)}
      consequence={STAFF_COPY.deactivateConsequence}
      successMessage={STAFF_COPY.staffUpdated}
      onConfirm={async ({ reason }) => {
        await apiFetch(path(row.id, "/deactivate"), { method: "POST", body: { reason } });
        router.refresh();
      }}
    />
  );

  return (
    <>
      <AdminDrawer
        open={open}
        onOpenChange={onOpenChange}
        kind={STAFF_COPY.drawerKind}
        title={row.name.trim() || row.email}
        subtitle={row.email}
        status={<StatusBadge kind="role" status={row.role} />}
        fields={fields}
        sections={sections}
        footer={footer}
      >
        {self ? <p className="m-0 text-[13px] font-semibold text-ink-2">{STAFF_COPY.ownRecord}</p> : null}
      </AdminDrawer>
      <DestructiveAction
        actionKey="staff.change_role"
        targetId={row.id}
        hideTrigger
        open={roleTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRoleTarget(null);
        }}
        title={STAFF_COPY.roleTitle(name, roleTarget ? roleLabel(roleTarget) : "")}
        consequence={
          roleTarget && requiresTwoStep(roleTarget) && !row.twoStepEnabled
            ? `${STAFF_COPY.roleConsequence} ${STAFF_COPY.roleTwoStepNote}`
            : STAFF_COPY.roleConsequence
        }
        successMessage={STAFF_COPY.roleUpdated}
        onConfirm={async ({ reason }) => {
          if (!roleTarget) return;
          await apiFetch(path(row.id), { method: "PATCH", body: { role: roleTarget, reason } });
          router.refresh();
        }}
      />
      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={STAFF_COPY.revokeTitle(row.email)}
        description={STAFF_COPY.revokeConsequence}
        confirmLabel={STAFF_COPY.revoke}
        tone="danger"
        icon="cancel"
        onConfirm={async ({ reason }) => {
          await apiFetch(path(row.id, "/invite"), { method: "DELETE", body: { reason } });
          adminToast.success(STAFF_COPY.revoked);
          close();
          router.refresh();
        }}
      />
    </>
  );
}
