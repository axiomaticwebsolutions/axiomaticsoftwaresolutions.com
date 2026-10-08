"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { useAccountSearch } from "@/components/admin/customers/use-account-search";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { AdminCustomerRow } from "@/lib/admin/customers/model";
import type { ManualIssuePlanOption, ManualIssueResult } from "@/lib/admin/licenses/model";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { validateReason } from "@/lib/rbac";

/** New copy (the prototype has no manual issue): owner review. */
export const ISSUE_COPY = {
  trigger: "Issue license",
  title: "Issue a license",
  description: "Issues a key to a customer account at no charge. The account owner gets an email with a link to the license; the key is never shown here.",
  account: "Customer account",
  accountHint: "Search by business, name, email or GSTIN.",
  accountPlaceholder: "Search customers",
  noMatches: "No matching accounts.",
  plan: "Plan",
  planPlaceholder: "Choose a plan",
  terminals: "Terminals",
  reason: "Reason (saved to the audit log)",
  submit: "Issue license",
  chooseAccount: "Choose a customer account.",
  choosePlan: "Choose a plan.",
  done: (r: ManualIssueResult) => (r.emailedTo ? `${r.id} issued \u00B7 key link emailed to ${r.emailedTo}` : `${r.id} issued \u00B7 the account has no owner to email`),
} as const;

type Errors = Partial<Record<"accountId" | "planId" | "quantity" | "reason" | "form", string>>;

function IssueForm({ plans, onDone }: { plans: readonly ManualIssuePlanOption[]; onDone: (result: ManualIssueResult) => void }) {
  const id = React.useId();
  const [query, setQuery] = React.useState("");
  const [account, setAccount] = React.useState<AdminCustomerRow | null>(null);
  const [planId, setPlanId] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<Errors>({});
  const [busy, setBusy] = React.useState(false);
  const { results, loading } = useAccountSearch(query);
  const plan = plans.find((p) => p.id === planId) ?? null;
  const groups = React.useMemo(() => {
    const map = new Map<string, ManualIssuePlanOption[]>();
    for (const p of plans) map.set(p.productName, [...(map.get(p.productName) ?? []), p]);
    return [...map.entries()];
  }, [plans]);
  const options = account && !results.some((r) => r.id === account.id) ? [account, ...results] : results;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {};
    if (!account) next.accountId = ISSUE_COPY.chooseAccount;
    if (!plan) next.planId = ISSUE_COPY.choosePlan;
    const checked = validateReason(reason);
    if (!checked.ok) next.reason = checked.message;
    const qty = Number(quantity);
    if (plan?.perUnit && (!Number.isInteger(qty) || qty < 1 || qty > (plan.maxQty ?? 100))) next.quantity = `Enter between 1 and ${plan.maxQty ?? 100} terminals.`;
    setErrors(next);
    if (Object.keys(next).length > 0 || !account || !plan || !checked.ok) return;
    setBusy(true);
    try {
      const { license } = await apiFetch<{ license: ManualIssueResult }>("/api/admin/licenses", {
        method: "POST",
        body: { accountId: account.id, planId: plan.id, reason: checked.reason, ...(plan.perUnit ? { quantity: qty } : {}) },
      });
      onDone(license);
    } catch (error) {
      const fields = error instanceof ApiClientError ? error.fieldErrors : {};
      setErrors({
        accountId: fields.accountId?.[0],
        planId: fields.planId?.[0],
        quantity: fields.quantity?.[0],
        reason: fields.reason?.[0],
        form: Object.keys(fields).length > 0 ? undefined : error instanceof Error ? error.message : "Something went wrong. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-3.5">
      <Field size="sm" label={ISSUE_COPY.account} hint={account ? `Selected: ${account.legalName}` : ISSUE_COPY.accountHint} error={errors.accountId}>
        <Input size="sm" type="search" value={query} placeholder={ISSUE_COPY.accountPlaceholder} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      </Field>
      {options.length > 0 || (query.trim().length >= 2 && !loading) ? (
        <fieldset className="m-0 grid min-w-0 gap-1 border-0 p-0" aria-busy={loading || undefined}>
          <legend className="sr-only">Matching accounts</legend>
          {options.length === 0 ? <p className="m-0 text-[13px] text-ink-2">{ISSUE_COPY.noMatches}</p> : null}
          {options.map((r) => (
            <label
              key={r.id}
              htmlFor={`${id}-account-${r.id}`}
              className="flex cursor-pointer items-start gap-2.5 rounded-8 border border-line-alt px-2.5 py-2 text-[13px] has-[:checked]:border-primary has-[:checked]:bg-lavender-soft"
            >
              <input
                id={`${id}-account-${r.id}`}
                type="radio"
                name={`${id}-account`}
                value={r.id}
                checked={account?.id === r.id}
                onChange={() => setAccount(r)}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0 font-bold">
                {r.legalName}
                <span className="block text-[12px] font-semibold text-ink-2">{[r.ownerName, r.ownerEmail].filter(Boolean).join(" \u00B7 ") || "No owner"}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <Field size="sm" label={ISSUE_COPY.plan} error={errors.planId}>
        <NativeSelect size="sm" value={planId} placeholder={ISSUE_COPY.planPlaceholder} onChange={(e) => setPlanId(e.target.value)}>
          {groups.map(([product, items]) => (
            <optgroup key={product} label={product}>
              {items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </Field>
      {plan?.perUnit ? (
        <Field size="sm" label={ISSUE_COPY.terminals} error={errors.quantity}>
          <Input size="sm" type="number" inputMode="numeric" min={1} max={plan.maxQty ?? 100} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
      ) : null}
      <Field size="sm" label={ISSUE_COPY.reason} error={errors.reason}>
        <Textarea size="sm" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {errors.form ? (
        <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
          {errors.form}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" variant="primary" size="sm" aria-busy={busy || undefined} disabled={busy}>
          {busy ? <Spinner size="sm" tone="onPrimary" /> : null}
          {ISSUE_COPY.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * "Issue license" page action (licenses.manage; disabled with "Requires ..." for Finance) and its dialog: account
 * search, plan, terminals for per-terminal plans, reason. On success the new license's drawer opens.
 */
export function IssueLicenseAction({ plans }: { plans: readonly ManualIssuePlanOption[] }) {
  const router = useRouter();
  const drawer = useDrawerParam();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <AdminAction perm="licenses.manage" variant="primary" icon="add" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {ISSUE_COPY.trigger}
      </AdminAction>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="leading-[normal]">
          <DialogHeader>
            <DialogTitle>{ISSUE_COPY.title}</DialogTitle>
            <DialogDescription className="text-[13.5px]">{ISSUE_COPY.description}</DialogDescription>
          </DialogHeader>
          <IssueForm
            plans={plans}
            onDone={(result) => {
              setOpen(false);
              adminToast.success(ISSUE_COPY.done(result));
              router.refresh();
              drawer.open(result.id);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
