"use client";

import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { AdminDrawer, type AdminField } from "@/components/admin/drawer";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatAdminDateTimeLong } from "@/lib/admin/audit/format";
import {
  AUDIT_COPY,
  auditRoleLabel,
  maskIp,
  targetHref,
  targetTypeLabel,
  type AuditRow,
} from "@/lib/admin/audit/model";

export type AuditDrawerProps = {
  row: AuditRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Audit event drawer (prototype kind "AUDIT EVENT"): the action as title, the time, the actor role badge, and every
 * stored field (actor, role, target, type and id, reason, detail, masked IP, event id). Read-only: no actions besides
 * opening the target in its module when the viewer can open that module.
 */
export function AuditDrawer({ row, open, onOpenChange }: AuditDrawerProps) {
  const admin = useAdmin();
  if (!row) {
    return <AdminDrawer open={open} onOpenChange={onOpenChange} kind={AUDIT_COPY.drawerKind} title={AUDIT_COPY.caption} error={AUDIT_COPY.notFound} />;
  }
  const link = targetHref(row);
  const fields: AdminField[] = [
    { label: AUDIT_COPY.fields.actor, value: row.actorName },
    { label: AUDIT_COPY.fields.role, value: auditRoleLabel(row.actorRole) },
    { label: AUDIT_COPY.fields.target, value: row.target, mono: true, wide: true },
    { label: AUDIT_COPY.fields.targetType, value: row.targetType ? targetTypeLabel(row.targetType) : null },
    { label: AUDIT_COPY.fields.targetId, value: row.targetId, mono: true },
    { label: AUDIT_COPY.fields.reason, value: row.reason, wide: true },
    { label: AUDIT_COPY.fields.detail, value: row.detail, wide: true },
    { label: AUDIT_COPY.fields.ip, value: row.ipPrefix ? maskIp(row.ipPrefix) : null, mono: true },
    { label: AUDIT_COPY.fields.id, value: row.id, mono: true },
  ];
  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind={AUDIT_COPY.drawerKind}
      title={row.action}
      subtitle={formatAdminDateTimeLong(row.at)}
      status={<StatusBadge kind="role" status={row.actorRole} label={auditRoleLabel(row.actorRole)} />}
      fields={fields}
      footer={
        link && admin.canView(link.module) ? (
          <AdminAction size="sm" icon="open_in_new" href={link.href}>
            {AUDIT_COPY.openTarget}
          </AdminAction>
        ) : null
      }
    />
  );
}
