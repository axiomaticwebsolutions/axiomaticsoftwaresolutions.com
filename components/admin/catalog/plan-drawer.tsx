"use client";

import * as React from "react";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { StatusBadge } from "@/components/admin/status-badge";
import { Icon } from "@/components/icons/icon";
import { PLAN_TYPE_LABELS, planDeviceLimitLabel, planExpiryBehaviour, planTermDetail, planUpdatesLabel } from "@/lib/admin/catalog/model";
import type { AdminPlanDetail } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { formatINR, withTax } from "@/lib/money";
import { planFormValue, planPayload, PricingFields, TermsFields, type PlanFormValue } from "./plan-form";
import { fieldErrorsOf, FormAlert, formErrorOf, useDetail } from "./shared";

const TERM_KEYS = ["name", "trialDays", "interval", "updatesMonths", "perUnit", "maxQty", "sortOrder", "includes", "multiDevice"];

function PricingForm({ plan, readOnly, onSaved }: { plan: AdminPlanDetail; readOnly: boolean; onSaved: (p: AdminPlanDetail) => void }) {
  const uid = React.useId();
  const [value, setValue] = React.useState<PlanFormValue>(() => planFormValue(plan));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [more, setMore] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly) return;
    const { body, errors: local } = planPayload(value, plan.type);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      // Prototype: an invalid price is reported as an error toast.
      adminToast.error(null, local.pricePaise ?? "Please fix the highlighted fields.");
      if (TERM_KEYS.some((k) => local[k])) setMore(true);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ plan: AdminPlanDetail; changed: boolean }>(`/api/admin/plans/${encodeURIComponent(plan.id)}`, { method: "PATCH", body });
      setErrors({});
      adminToast.success(res.changed ? "Changes saved" : "No changes to save");
      onSaved(res.plan);
    } catch (error) {
      const fields = fieldErrorsOf(error);
      setErrors(fields);
      setFormError(formErrorOf(error));
      if (TERM_KEYS.some((k) => fields[k])) setMore(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2.5">
      <PricingFields value={value} onChange={setValue} errors={errors} type={plan.type} idPrefix={uid} />
      <details open={more} onToggle={(e) => setMore(e.currentTarget.open)} className="group rounded-10 border border-line-subtle">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-10 px-3 py-2 text-[12.5px] font-extrabold [&::-webkit-details-marker]:hidden">
          Name, terms and display
          <Icon name="expand_more" size={18} className="text-ink-2 transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-2.5 border-t border-line-subtle p-3">
          <TermsFields value={value} onChange={setValue} errors={errors} type={plan.type} idPrefix={uid} />
        </div>
      </details>
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined} />
    </form>
  );
}

type DrawerProps = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gstRatePct: number;
  offlineGraceDays: number;
  onChanged: () => void;
};

/**
 * Plan drawer (Admin Console.dc.html plans detail): facts (prices excl./incl. GST, term, devices, updates, expiry
 * behaviour, offline grace), "Pricing & limits" (pricing.manage; read only otherwise; price changes audited
 * old -> new) and Archive plan / Restore (reason, audited). Plans are never deleted.
 */
export function PlanDrawer({ id, open, onOpenChange, gstRatePct, offlineGraceDays, onChanged }: DrawerProps) {
  const { can } = useAdmin();
  const canEdit = can("pricing.manage");
  const detail = useDetail(id ? `/api/admin/plans/${encodeURIComponent(id)}` : null, (b) => (b as { plan: AdminPlanDetail }).plan);
  const p = detail.data;
  const saved = (next: AdminPlanDetail) => {
    detail.set(next);
    onChanged();
  };

  async function setArchived(archived: boolean, reason: string) {
    if (!p) return;
    const res = await apiFetch<{ plan: AdminPlanDetail }>(`/api/admin/plans/${encodeURIComponent(p.id)}/${archived ? "archive" : "restore"}`, {
      method: "POST",
      body: { reason },
    });
    saved(res.plan);
  }

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Plan"
      title={p ? `${p.productName} \u00B7 ${p.name}` : (id ?? "Plan")}
      subtitle={p?.id}
      status={p ? <StatusBadge kind="plan" status={p.archived ? "archived" : "active"} /> : undefined}
      loading={detail.loading}
      error={detail.error}
      fields={
        p
          ? [
              { label: "Type", value: p.multiDevice ? `${PLAN_TYPE_LABELS[p.type]} \u00B7 Multi-device` : PLAN_TYPE_LABELS[p.type] },
              { label: "Price (excl. GST)", value: p.pricePaise > 0 ? formatINR(p.pricePaise, { exact: true }) : "Free" },
              { label: `Price incl. ${gstRatePct}% GST`, value: p.pricePaise > 0 ? formatINR(withTax(p.pricePaise, gstRatePct), { exact: true }) : null },
              { label: "Term", value: planTermDetail(p) },
              { label: "Device limit", value: planDeviceLimitLabel(p) },
              { label: "Updates included", value: planUpdatesLabel(p) },
              { label: "Expiry behaviour", value: planExpiryBehaviour(p.type) },
              { label: "Offline grace", value: `${offlineGraceDays} days` },
            ]
          : undefined
      }
      edit={p ? { title: "Pricing & limits", readOnly: !canEdit, form: <PricingForm key={`${p.id}:${p.updatedAt}`} plan={p} readOnly={!canEdit} onSaved={saved} /> } : undefined}
      footer={
        p ? (
          p.archived ? (
            <DestructiveAction
              actionKey="plans.restore"
              targetId={p.id}
              targetLabel={p.name}
              confirmLabel="Confirm"
              consequence="The plan goes back on sale."
              successMessage="Plan updated"
              onConfirm={({ reason }) => setArchived(false, reason)}
            />
          ) : (
            <DestructiveAction
              actionKey="plans.archive"
              targetId={p.id}
              targetLabel={p.name}
              confirmLabel="Confirm"
              consequence="It can’t be bought anymore. Existing licenses are unaffected."
              successMessage="Plan updated"
              onConfirm={({ reason }) => setArchived(true, reason)}
            />
          )
        ) : undefined
      }
    />
  );
}
