"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer, type AdminDrawerSection, type AdminField } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge, statusMeta } from "@/components/admin/status-badge";
import { apiFetch } from "@/lib/client/api";
import { formatDateIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import {
  EXTEND_DEFAULT_DAYS,
  LICENSE_COPY,
  LICENSE_TOASTS,
  relativeAgo,
  shortDateTimeIST,
  type AdminLicenseDetail,
} from "@/lib/admin/licenses/model";
import { useAdminDetail } from "./use-detail";

export type LicenseDrawerProps = {
  /** License id from the URL (?id=), or null when closed. */
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a successful action (refresh the list behind the drawer). */
  onChanged?: () => void;
  /** Extra footer actions for the module that opened it (Renewals: "Send reminder now"). */
  footerExtra?: (license: AdminLicenseDetail, changed: () => void) => React.ReactNode;
};

const date = (iso: string | null, fallback = "No end date") => (iso ? formatDateIST(new Date(iso)) : fallback);

export function licensePath(id: string, verb?: string): string {
  return `/api/admin/licenses/${encodeURIComponent(id)}${verb ? `/${verb}` : ""}`;
}

function fieldsOf(l: AdminLicenseDetail): AdminField[] {
  const fields: AdminField[] = [
    { label: "Customer", value: [l.contactName, l.businessName].filter(Boolean).join(" \u00B7 ") || "Unclaimed license" },
    { label: "Email", value: l.contactEmail },
    { label: "Key", value: l.keyMasked, mono: true },
    { label: "Order", value: l.orderId ?? l.origin, mono: !!l.orderId },
    { label: "Issued", value: date(l.issuedAt) },
    { label: "Expires", value: date(l.expiresAt) },
    { label: "Updates until", value: date(l.updatesUntil) },
    { label: "Devices", value: `${l.devicesUsed} of ${l.deviceLimit}` },
    { label: "Self-service resets used", value: `${l.selfServiceResetsUsed} of ${l.selfServiceResetsPerYear}` },
    // decisions.md rule 2: no mandates in v1, every renewal is manual.
    { label: "Auto-renew", value: "No (renewals are manual)" },
  ];
  if (l.revokedAt) {
    fields.push({ label: "Revoked", value: `${date(l.revokedAt)}${l.revokedReason ? ` \u00B7 ${l.revokedReason}` : ""}`, wide: true });
  }
  return fields;
}

function sectionsOf(l: AdminLicenseDetail, changed: () => void): AdminDrawerSection[] {
  const now = new Date();
  const revoked = l.status === "revoked";
  return [
    {
      id: "devices",
      title: l.devicesTotal > l.devices.length ? `Devices (${l.devices.length} of ${l.devicesTotal})` : "Devices",
      empty: "No devices activated.",
      content:
        l.devices.length === 0 ? null : (
          <SectionRows>
            {l.devices.map((d) => (
              <SectionRow
                key={d.id}
                title={`${d.name} \u00B7 ${d.os}`}
                detail={`${d.fingerprintShort} \u00B7 activated ${date(d.activatedAt)} \u00B7 seen ${relativeAgo(d.lastSeenAt, now)}`}
                status={d.active ? "Active" : "Deactivated"}
                tone={d.active ? "sage" : "muted"}
                action={
                  d.active && !revoked ? (
                    <DestructiveAction
                      actionKey="licenses.deactivate_device"
                      targetId={d.id}
                      targetLabel={d.name}
                      size="xs"
                      icon="computer"
                      consequence={LICENSE_COPY.deactivateDevice(l.id)}
                      successMessage={LICENSE_TOASTS.deactivateDevice}
                      onConfirm={async ({ reason }) => {
                        const path = `${licensePath(l.id)}/devices/${encodeURIComponent(d.id)}/deactivate`;
                        await apiFetch(path, { method: "POST", body: { reason } });
                        changed();
                      }}
                    />
                  ) : undefined
                }
              />
            ))}
          </SectionRows>
        ),
    },
    {
      id: "history",
      title: "History",
      empty: "No history yet.",
      content:
        l.history.length === 0 ? null : (
          <SectionRows>
            {l.history.map((h) => (
              <SectionRow key={h.id} title={h.label} detail={h.by} status={shortDateTimeIST(h.at)} />
            ))}
          </SectionRows>
        ),
    },
    {
      id: "orders",
      title: "Orders",
      empty: "No orders. Trials and staff-issued licenses have none.",
      content:
        l.orders.length === 0 ? null : (
          <SectionRows>
            {l.orders.map((o) => (
              <SectionRow
                key={o.id}
                title={`${o.id} \u00B7 ${formatINR(o.totalPaise)}`}
                detail={`${o.kind} \u00B7 ${date(o.createdAt)}`}
                status={statusMeta("order", o.status).label}
                action={
                  <AdminAction size="xs" href={`/admin/orders?id=${encodeURIComponent(o.id)}`} aria-label={`Open order ${o.id}`}>
                    Open
                  </AdminAction>
                }
              />
            ))}
          </SectionRows>
        ),
    },
  ];
}

/** Footer (prototype licDetail actions): Reinstate or Suspend, Extend 30 days, Reset devices, Revoke; none when revoked. */
function FooterActions({ l, changed }: { l: AdminLicenseDetail; changed: () => void }) {
  if (l.status === "revoked") return null;
  const post = async (verb: string, body: Record<string, unknown>) => {
    await apiFetch(licensePath(l.id, verb), { method: "POST", body });
    changed();
  };
  return (
    <>
      {l.status === "suspended" ? (
        <DestructiveAction
          actionKey="licenses.reinstate"
          targetId={l.id}
          consequence={LICENSE_COPY.reinstate}
          successMessage={LICENSE_TOASTS.reinstate}
          onConfirm={({ reason }) => post("reinstate", { reason })}
        />
      ) : (
        <DestructiveAction
          actionKey="licenses.suspend"
          targetId={l.id}
          consequence={LICENSE_COPY.suspend}
          successMessage={LICENSE_TOASTS.suspend}
          onConfirm={({ reason }) => post("suspend", { reason })}
        />
      )}
      <DestructiveAction
        actionKey="licenses.extend"
        targetId={l.id}
        triggerLabel={`Extend ${EXTEND_DEFAULT_DAYS} days`}
        title={`Extend ${l.id} by ${EXTEND_DEFAULT_DAYS} days?`}
        consequence={LICENSE_COPY.extend(EXTEND_DEFAULT_DAYS)}
        successMessage={LICENSE_TOASTS.extend(EXTEND_DEFAULT_DAYS)}
        onConfirm={({ reason }) => post("extend", { reason, days: EXTEND_DEFAULT_DAYS })}
      />
      <DestructiveAction
        actionKey="licenses.reset_devices"
        targetId={l.id}
        consequence={LICENSE_COPY.resetDevices(l.devicesUsed)}
        successMessage={LICENSE_TOASTS.resetDevices}
        onConfirm={({ reason }) => post("reset-devices", { reason })}
      />
      <DestructiveAction
        actionKey="licenses.revoke"
        targetId={l.id}
        consequence={LICENSE_COPY.revoke}
        successMessage={LICENSE_TOASTS.revoke}
        onConfirm={({ reason, confirmId }) => post("revoke", { reason, confirmId })}
      />
    </>
  );
}

/** The license drawer (Admin Console.dc.html licDetail), shared by Licenses and Renewals. */
export function LicenseDrawer({ id, open, onOpenChange, onChanged, footerExtra }: LicenseDrawerProps) {
  const detail = useAdminDetail<{ license: AdminLicenseDetail }, AdminLicenseDetail>(id ? licensePath(id) : null, (r) => r.license);
  const { reload } = detail;
  const changed = React.useCallback(() => {
    reload();
    onChanged?.();
  }, [reload, onChanged]);
  const l = detail.data;
  const extra = l ? footerExtra?.(l, changed) : null;
  const actions = l && l.status !== "revoked";
  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="License"
      title={l ? `${l.id} \u00B7 ${l.productShortName}` : (id ?? "")}
      status={l ? <StatusBadge kind="license" status={l.status} /> : undefined}
      subtitle={l ? `${l.planName} \u00B7 ${l.contactName ?? l.businessName ?? "Unclaimed"}` : undefined}
      loading={detail.loading}
      error={detail.error}
      fields={l ? fieldsOf(l) : undefined}
      sections={l ? sectionsOf(l, changed) : undefined}
      footer={
        l && (actions || extra) ? (
          <>
            <FooterActions l={l} changed={changed} />
            {extra}
          </>
        ) : undefined
      }
    />
  );
}
