"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer, type AdminDrawerSection, type AdminField } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { statusMeta } from "@/components/admin/status-badge";
import { useAdminDetail } from "@/components/admin/licenses/use-detail";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CUSTOMER_COPY,
  CUSTOMER_RECORD_COPY as RECORD_COPY,
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
import { useCustomerEdit } from "./customer-edit-form";
import { SetPasswordLinkPanel, type OneTimeLink } from "./set-password-link";

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

/**
 * Footer: "Resend verification" (customers.manage), "Mark email as verified" (customers.verify_email), and "Send
 * password reset" for an owner with a password, else "Create set-password link" (customers.manage) for an active
 * owner without one. The set-password link opens once in a dialog and is dropped when it closes.
 */
function FooterActions({ c, onChanged }: { c: AdminCustomerDetail; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<EmailAction | null>(null);
  const [link, setLink] = React.useState<OneTimeLink | null>(null);
  const linkRef = React.useRef<HTMLDivElement>(null);
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
  const ownerName = owner ? owner.name || owner.email : "";
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
      <DestructiveAction
        actionKey="customers.verify_email"
        targetId={owner?.email ?? c.id}
        disabledReason={!owner ? RECORD_COPY.noActiveOwner : owner.verified ? RECORD_COPY.verifiedAlready : undefined}
        consequence={owner ? RECORD_COPY.verifyConsequence(owner.email, ownerName, c.legalName) : null}
        successMessage={RECORD_COPY.verifyDone}
        onConfirm={async ({ reason }) => {
          await apiFetch(customerPath(c.id, "verify-email"), { method: "POST", body: { reason } });
          onChanged();
        }}
      />
      {owner && !owner.hasPassword && owner.canSetPassword ? (
        <DestructiveAction
          actionKey="customers.set_password_link"
          targetId={owner.email}
          targetLabel={ownerName}
          consequence={RECORD_COPY.linkConsequence(ownerName, owner.email)}
          onConfirm={async ({ reason }) => {
            const result = await apiFetch<{ url: string; expiresAt: string; emailSent: boolean }>(customerPath(c.id, "set-password-link"), {
              method: "POST",
              body: { reason },
            });
            setLink({ url: result.url, expiresAt: result.expiresAt, emailSent: result.emailSent, name: ownerName });
          }}
        />
      ) : (
        <AdminAction perm="customers.manage" size="sm" icon="lock_reset" busy={busy === "password-reset"} disabledReason={unavailable} onClick={() => send("password-reset")}>
          {CUSTOMER_COPY.sendPasswordReset}
        </AdminAction>
      )}
      <Dialog open={link !== null} onOpenChange={(next) => (next ? undefined : setLink(null))}>
        <DialogContent
          className="leading-[normal]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            linkRef.current?.querySelector<HTMLElement>("[data-link-panel]")?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{RECORD_COPY.linkDialogTitle}</DialogTitle>
            <DialogDescription className="text-[13.5px]">{ownerName}</DialogDescription>
          </DialogHeader>
          <div ref={linkRef}>{link ? <SetPasswordLinkPanel link={link} /> : null}</div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                {RECORD_COPY.close}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type CustomerDrawerProps = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a change in the drawer (edit, verify): re-read the list. */
  onChanged?: () => void;
};

/**
 * The customer drawer (Admin Console.dc.html customers detail) for one business account: facts, the "Edit details"
 * card (customers.edit; read only otherwise), members, licenses, orders, tickets and the footer actions.
 */
export function CustomerDrawer({ id, open: isOpen, onOpenChange, onChanged }: CustomerDrawerProps) {
  const detail = useAdminDetail<{ customer: AdminCustomerDetail }, AdminCustomerDetail>(id ? customerPath(id) : null, (r) => r.customer);
  const c = detail.data;
  const { reload } = detail;
  const changed = React.useCallback(() => {
    reload();
    onChanged?.();
  }, [reload, onChanged]);
  const edit = useCustomerEdit(c, changed);
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
      edit={edit}
      sections={c ? sectionsOf(c) : undefined}
      footer={c ? <FooterActions c={c} onChanged={changed} /> : undefined}
    />
  );
}
