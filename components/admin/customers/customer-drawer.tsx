"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer, type AdminDrawerSection, type AdminField } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { statusMeta } from "@/components/admin/status-badge";
import { useAdminDetail } from "@/components/admin/licenses/use-detail";
import {
  CUSTOMER_COPY,
  locationLabel,
  TEAM_ROLE_SHORT,
  type AdminCustomerDetail,
  type AdminCustomerMember,
} from "@/lib/admin/customers/model";
import { adminLicenseHref } from "@/lib/admin/licenses/model";
import { apiFetch } from "@/lib/client/api";
import { formatDateIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { EmailBadge } from "./customer-columns";

const date = (iso: string | null, fallback: string) => (iso ? formatDateIST(new Date(iso)) : fallback);
const customerPath = (id: string, verb?: string) => `/api/admin/customers/${encodeURIComponent(id)}${verb ? `/${verb}` : ""}`;

function memberStatus(m: AdminCustomerMember): { label: string; tone: "sage" | "peach" | "muted" } {
  if (m.status === "INVITED") return { label: "Invited", tone: "muted" };
  return m.verified ? { label: "Verified", tone: "sage" } : { label: "Unverified", tone: "peach" };
}

function fieldsOf(c: AdminCustomerDetail): AdminField[] {
  return [
    { label: "Email", value: c.owner?.email },
    { label: "Phone", value: c.owner?.phone },
    { label: "Business", value: c.legalName },
    { label: "GSTIN", value: c.gstin ?? "Unregistered", mono: true },
    { label: "Location", value: locationLabel(c.city, c.state) },
    { label: "Lifetime value", value: formatINR(c.lifetimeValuePaise, { exact: true }) },
    { label: "Last order", value: date(c.lastOrderAt, "No paid orders") },
    { label: "Customer since", value: date(c.createdAt, "\u2014") },
  ];
}

const open = (href: string, label: string) => (
  <AdminAction size="xs" href={href} aria-label={label}>
    Open
  </AdminAction>
);

function sectionsOf(c: AdminCustomerDetail): AdminDrawerSection[] {
  const more = (shown: number, total: number) => (total > shown ? ` \u00B7 latest ${shown}` : "");
  return [
    {
      id: "members",
      title: `Members (${c.members.length})`,
      empty: "No members.",
      content:
        c.members.length === 0 ? null : (
          <SectionRows>
            {c.members.map((m) => {
              const s = memberStatus(m);
              return <SectionRow key={m.userId} title={`${m.name || m.email} \u00B7 ${TEAM_ROLE_SHORT[m.role]}`} detail={m.email} status={s.label} tone={s.tone} />;
            })}
          </SectionRows>
        ),
    },
    {
      id: "licenses",
      title: `Licenses (${c.licensesTotal})${more(c.licenses.length, c.licensesTotal)}`,
      empty: CUSTOMER_COPY.licensesEmpty,
      content:
        c.licenses.length === 0 ? null : (
          <SectionRows>
            {c.licenses.map((l) => (
              <SectionRow
                key={l.id}
                title={`${l.id} \u00B7 ${l.productName}`}
                detail={`${l.planName} \u00B7 ${l.expiresAt ? `ends ${date(l.expiresAt, "")}` : "no end date"}`}
                status={statusMeta("license", l.status).label}
                action={open(adminLicenseHref(l.id), `Open license ${l.id}`)}
              />
            ))}
          </SectionRows>
        ),
    },
    {
      id: "orders",
      title: `Orders (${c.ordersTotal})${more(c.orders.length, c.ordersTotal)}`,
      empty: CUSTOMER_COPY.ordersEmpty,
      content:
        c.orders.length === 0 ? null : (
          <SectionRows>
            {c.orders.map((o) => (
              <SectionRow
                key={o.id}
                title={`${o.id} \u00B7 ${formatINR(o.totalPaise)}`}
                detail={o.lines}
                status={statusMeta("order", o.status).label}
                action={open(`/admin/orders?id=${encodeURIComponent(o.id)}`, `Open order ${o.id}`)}
              />
            ))}
          </SectionRows>
        ),
    },
    {
      id: "tickets",
      title: c.ticketsTotal > 0 ? `Tickets (${c.ticketsTotal})` : "Tickets",
      empty: CUSTOMER_COPY.ticketsEmpty,
      content:
        c.tickets.length === 0 ? null : (
          <SectionRows>
            {c.tickets.map((t) => (
              <SectionRow
                key={t.id}
                title={`${t.id} \u00B7 ${t.subject}`}
                status={statusMeta("ticket", t.status).label}
                action={open(`/admin/tickets?id=${encodeURIComponent(t.id)}`, `Open ticket ${t.id}`)}
              />
            ))}
          </SectionRows>
        ),
    },
  ];
}

type EmailAction = "resend-verification" | "password-reset";

/** Footer (prototype): "Resend verification" and "Send password reset" for the owner (customers.manage). */
function FooterActions({ c }: { c: AdminCustomerDetail }) {
  const [busy, setBusy] = React.useState<EmailAction | null>(null);
  const owner = c.owner;
  const unavailable = !owner ? CUSTOMER_COPY.noOwner : !owner.hasPassword ? CUSTOMER_COPY.noPassword : undefined;
  async function send(action: EmailAction) {
    if (busy) return;
    setBusy(action);
    try {
      const result = await apiFetch<{ email: string; sent: boolean }>(customerPath(c.id, action), { method: "POST", body: {} });
      if (!result.sent) adminToast.error(null, CUSTOMER_COPY.emailNotSent);
      else adminToast.success(action === "password-reset" ? CUSTOMER_COPY.resetSent(result.email) : CUSTOMER_COPY.verificationSent(result.email));
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <AdminAction
        perm="customers.manage"
        size="sm"
        icon="mark_email_unread"
        busy={busy === "resend-verification"}
        disabledReason={unavailable ?? (owner?.verified ? CUSTOMER_COPY.alreadyVerified : undefined)}
        onClick={() => send("resend-verification")}
      >
        {CUSTOMER_COPY.resendVerification}
      </AdminAction>
      <AdminAction perm="customers.manage" size="sm" icon="lock_reset" busy={busy === "password-reset"} disabledReason={unavailable} onClick={() => send("password-reset")}>
        {CUSTOMER_COPY.sendPasswordReset}
      </AdminAction>
    </>
  );
}

export type CustomerDrawerProps = { id: string | null; open: boolean; onOpenChange: (open: boolean) => void };

/** The customer drawer (Admin Console.dc.html customers detail) for one business account. */
export function CustomerDrawer({ id, open: isOpen, onOpenChange }: CustomerDrawerProps) {
  const detail = useAdminDetail<{ customer: AdminCustomerDetail }, AdminCustomerDetail>(id ? customerPath(id) : null, (r) => r.customer);
  const c = detail.data;
  return (
    <AdminDrawer
      open={isOpen}
      onOpenChange={onOpenChange}
      kind="Customer"
      title={c ? c.owner?.name || c.legalName : "Customer"}
      status={c ? <EmailBadge verified={c.owner ? c.owner.verified : null} /> : undefined}
      subtitle={c ? (c.owner ? c.legalName : "No active owner") : undefined}
      loading={detail.loading}
      error={detail.error}
      fields={c ? fieldsOf(c) : undefined}
      sections={c ? sectionsOf(c) : undefined}
      footer={c ? <FooterActions c={c} /> : undefined}
    />
  );
}
