"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { useAccountSearch } from "@/components/admin/customers/use-account-search";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { withParam } from "@/components/admin/model";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AdminCustomerRow } from "@/lib/admin/customers/model";
import { ADMIN_ORDERS_API, ORDER_OFFLINE_PATH, type OfflineMethod } from "@/lib/admin/orders/model";
import {
  billingDraftFromCustomer,
  earliestReceivedOn,
  emptyOrderDraft,
  istToday,
  OFFLINE_METHOD_OPTIONS,
  ORDER_RECORD_COPY as COPY,
  orderFormErrors,
  orderItemsPayload,
  referenceRequiredMessage,
  rupeesToPaise,
  type AdminOrderPlanOption,
  type OrderFormDraft,
} from "@/lib/admin/orders/records-model";
import { apiFetch } from "@/lib/client/api";
import { formatINR } from "@/lib/money";
import { requiresLabel } from "@/lib/rbac";
import {
  CouponField,
  OrderBillingFields,
  OrderErrorSummary,
  orderErrorsFrom,
  OrderFormAlert,
  orderFieldId,
  OrderItemsEditor,
  OrderReasonField,
  OrderSummary,
  PaymentLinkPanel,
  useCustomerDetail,
  useOrderQuote,
  type PaymentLinkView,
} from "./order-form";

/** URL parameter of the "New order" drawer (?new=1). */
export const NEW_ORDER_PARAM = "new";

const PREFIX = "order-new";

type LinkCreated = PaymentLinkView & { orderId: string };
type OfflineCreated = { orderId: string; invoiceNumber: string; licensesIssued: number };

function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
}

/** Header action "New order" (orders.create): opens the create drawer. */
export function NewOrderAction() {
  const create = useDrawerParam(NEW_ORDER_PARAM);
  return (
    <AdminAction perm="orders.create" variant="primary" icon="add" onClick={() => create.open("1")} aria-haspopup="dialog">
      {COPY.newOrder}
    </AdminAction>
  );
}

/**
 * The customer picker (the "Issue license" pattern): search, then a radio list of business + owner email that stays on
 * screen; the chosen customer stays checked (and listed) while the search changes. Arrow keys move the choice without
 * removing the list, so keyboard focus never drops out of the form.
 */
function CustomerPicker({
  account,
  onChoose,
  error,
}: {
  account: AdminCustomerRow | null;
  onChoose: (account: AdminCustomerRow) => void;
  error?: string;
}) {
  const id = React.useId();
  const [query, setQuery] = React.useState("");
  const { results, loading } = useAccountSearch(query);
  const fieldId = orderFieldId(PREFIX, "accountId");
  const options = account && !results.some((r) => r.id === account.id) ? [account, ...results] : results;
  return (
    <div className="grid gap-1.5">
      <Field
        size="sm"
        label={COPY.customer}
        required
        hint={account ? COPY.customerSelected(account.legalName) : COPY.customerHint}
        error={error}
        id={fieldId}
      >
        <Input size="sm" type="search" value={query} placeholder={COPY.customerPlaceholder} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      </Field>
      {options.length > 0 || (query.trim().length >= 2 && !loading) ? (
        <fieldset className="m-0 grid min-w-0 gap-1 border-0 p-0" aria-busy={loading || undefined}>
          <legend className="sr-only">Matching customers</legend>
          {options.length === 0 ? <p className="m-0 text-[13px] text-ink-2">{COPY.noMatches}</p> : null}
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
                onChange={() => onChoose(r)}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0 font-bold">
                {r.legalName}
                <span className="block text-[12px] font-semibold text-ink-2">{[r.ownerName, r.ownerEmail].filter(Boolean).join(" · ") || "No owner"}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/**
 * "New order" drawer (?new=1; orders.create): customer, items, coupon, billing (prefilled from the customer), the live
 * server quote, how they pay, and the reason. "Send a payment link" creates the unpaid order and shows its link once;
 * "Record a payment we've received" (payments.record_offline) confirms, then marks the order paid and issues its
 * licenses and invoice now. `requestId` is created when the drawer opens and kept across retries, so a double click or
 * a network retry never creates a second order.
 */
export function NewOrderDrawer({
  open,
  onOpenChange,
  plans,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: readonly AdminOrderPlanOption[];
  onCreated?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const canCreate = useCan("orders.create");
  const canOffline = useCan("payments.record_offline");
  const [now] = React.useState(() => new Date());
  const today = istToday(now);
  const [draft, setDraft] = React.useState<OrderFormDraft>(() => emptyOrderDraft(today));
  const [account, setAccount] = React.useState<AdminCustomerRow | null>(null);
  const [errors, setErrors] = React.useState<{ fields: Record<string, string>; form: string | null }>({ fields: {}, form: null });
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [created, setCreated] = React.useState<LinkCreated | null>(null);
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [wasOpen, setWasOpen] = React.useState(open);
  const reset = () => {
    setDraft(emptyOrderDraft(today));
    setAccount(null);
    setErrors({ fields: {}, form: null });
    setCreated(null);
    setRequestId(newRequestId());
  };
  if (open !== wasOpen) {
    setWasOpen(open);
    reset();
  }

  const customer = useCustomerDetail(account?.id ?? null);
  const [prefilledFor, setPrefilledFor] = React.useState<string | null>(null);
  if (customer.customer && customer.customer.id !== prefilledFor) {
    setPrefilledFor(customer.customer.id);
    setDraft((d) => ({ ...d, billing: billingDraftFromCustomer(customer.customer as NonNullable<typeof customer.customer>) }));
  }
  const licenses = customer.customer?.licenses ?? [];
  const quote = useOrderQuote(account ? { accountId: account.id } : null, draft.lines, plans, draft.couponCode, draft.billing.state);
  const total = quote.quote ? formatINR(quote.quote.totalPaise, { exact: true }) : null;
  const set = <K extends keyof OrderFormDraft>(key: K, value: OrderFormDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function payload() {
    return {
      requestId,
      accountId: account?.id ?? "",
      items: orderItemsPayload(draft.lines, plans),
      couponCode: draft.couponCode.trim() || null,
      billing: draft.billing,
      reason: draft.reason.trim(),
    };
  }

  function check(): boolean {
    const local = orderFormErrors(draft, plans, { needCustomer: true, hasCustomer: account !== null, payment: true, now: new Date() });
    if (draft.mode === "offline" && quote.quote && rupeesToPaise(draft.amount) !== null && rupeesToPaise(draft.amount) !== quote.quote.totalPaise) {
      local.amountPaise = COPY.amountHint(formatINR(quote.quote.totalPaise, { exact: true }));
    }
    setErrors({ fields: local, form: null });
    return Object.keys(local).length === 0;
  }

  async function createLink() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ orderId: string; paymentUrl: string; paymentUrlExpiresAt: string }>(ADMIN_ORDERS_API, { method: "POST", body: payload() });
      setErrors({ fields: {}, form: null });
      setCreated({ orderId: result.orderId, url: result.paymentUrl, expiresAt: result.paymentUrlExpiresAt, email: draft.billing.email.trim() });
      onCreated?.();
    } catch (error) {
      setErrors(orderErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function recordOffline() {
    const amountPaise = rupeesToPaise(draft.amount) ?? 0;
    let result: OfflineCreated;
    try {
      result = await apiFetch<OfflineCreated>(ORDER_OFFLINE_PATH, {
        method: "POST",
        body: { ...payload(), method: draft.method, reference: draft.reference.trim() || null, receivedOn: draft.receivedOn, amountPaise },
      });
    } catch (error) {
      const next = orderErrorsFrom(error);
      // A refusal without a field (fulfilment failed, duplicate request, busy, rate limit) is shown in the confirmation,
      // which stays open where the user is looking; field errors close it and point at their fields.
      if (Object.keys(next.fields).length === 0) throw new Error(next.form ?? "Something went wrong. Try again.");
      setErrors(next);
      setConfirmOpen(false);
      return;
    }
    adminToast.success(COPY.offlineDone(result.orderId, result.invoiceNumber, result.licensesIssued));
    onCreated?.();
    openOrder(result.orderId);
  }

  function openOrder(orderId: string) {
    const search = withParam(withParam(window.location.search, NEW_ORDER_PARAM, null), "id", orderId);
    router.replace(`${pathname}${search}`, { scroll: false });
  }

  function submit() {
    if (!check()) return;
    if (draft.mode === "offline") setConfirmOpen(true);
    else void createLink();
  }

  const refMessage = referenceRequiredMessage(draft.method);
  const form = (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <OrderErrorSummary prefix={PREFIX} fields={errors.fields} />
      <OrderFormAlert>{errors.form}</OrderFormAlert>
      <CustomerPicker
        account={account}
        error={errors.fields.accountId}
        onChoose={(next) => {
          setAccount(next);
          setPrefilledFor(null);
        }}
      />
      <OrderItemsEditor prefix={PREFIX} lines={draft.lines} onChange={(lines) => set("lines", lines)} plans={plans} licenses={licenses} errors={errors.fields} quote={quote.quote} />
      <CouponField prefix={PREFIX} value={draft.couponCode} onChange={(v) => set("couponCode", v)} error={errors.fields.couponCode} quote={quote.quote} />
      <OrderBillingFields prefix={PREFIX} billing={draft.billing} onChange={(billing) => set("billing", billing)} errors={errors.fields} />
      <OrderSummary quote={quote.quote} loading={quote.loading} error={quote.error} />
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[12.5px] font-extrabold text-ink">{COPY.howPay}</legend>
        {(
          [
            { mode: "link", label: COPY.modeLink, hint: COPY.modeLinkHint, disabled: false },
            { mode: "offline", label: COPY.modeOffline, hint: canOffline ? COPY.modeOfflineHint : requiresLabel("payments.record_offline"), disabled: !canOffline },
          ] as const
        ).map((option) => {
          const optionId = orderFieldId(PREFIX, `mode-${option.mode}`);
          return (
            <div key={option.mode} className="flex items-start gap-2.5">
              <input
                id={optionId}
                type="radio"
                name={`${PREFIX}-mode`}
                value={option.mode}
                checked={draft.mode === option.mode}
                disabled={option.disabled}
                aria-describedby={`${optionId}-hint`}
                onChange={() => set("mode", option.mode)}
                className="mt-1 accent-primary"
              />
              <span className="grid gap-0.5">
                <label htmlFor={optionId} className="cursor-pointer text-[13px] font-bold text-ink">
                  {option.label}
                </label>
                <span id={`${optionId}-hint`} className="text-[12px] text-ink-2">
                  {option.hint}
                </span>
              </span>
            </div>
          );
        })}
        {draft.mode === "offline" ? (
          <div className="grid gap-2.5 rounded-10 border border-line-subtle p-2.5">
            <div className="grid gap-2.5 min-[26.25rem]:grid-cols-2">
              <Field size="sm" label={COPY.method} required id={orderFieldId(PREFIX, "method")} error={errors.fields.method}>
                {(control) => (
                  <ChoiceSelect {...control} size="sm" value={draft.method} onValueChange={(v) => set("method", v as OfflineMethod)} options={OFFLINE_METHOD_OPTIONS} />
                )}
              </Field>
              <Field
                size="sm"
                label={draft.method === "cheque" ? COPY.chequeNo : COPY.reference}
                optional={refMessage === null}
                required={refMessage !== null}
                id={orderFieldId(PREFIX, "reference")}
                error={errors.fields.reference}
              >
                <Input size="sm" mono autoComplete="off" spellCheck={false} maxLength={64} value={draft.reference} onChange={(e) => set("reference", e.target.value)} />
              </Field>
              <Field size="sm" label={COPY.receivedOn} required id={orderFieldId(PREFIX, "receivedOn")} error={errors.fields.receivedOn}>
                <Input size="sm" type="date" min={earliestReceivedOn(now)} max={today} value={draft.receivedOn} onChange={(e) => set("receivedOn", e.target.value)} />
              </Field>
              <Field
                size="sm"
                label={COPY.amount}
                required
                id={orderFieldId(PREFIX, "amountPaise")}
                hint={total ? COPY.amountHint(total) : undefined}
                error={errors.fields.amountPaise}
              >
                <Input size="sm" inputMode="decimal" autoComplete="off" value={draft.amount} onChange={(e) => set("amount", e.target.value)} />
              </Field>
            </div>
          </div>
        ) : null}
        {errors.fields.mode ? <FieldError>{errors.fields.mode}</FieldError> : null}
      </fieldset>
      <OrderReasonField prefix={PREFIX} value={draft.reason} error={errors.fields.reason} onChange={(reason) => set("reason", reason)} />
      <DrawerSubmit loading={busy}>{draft.mode === "offline" ? COPY.recordPayment : COPY.createOrder}</DrawerSubmit>
    </form>
  );

  return (
    <>
      <AdminDrawer
        open={open}
        onOpenChange={onOpenChange}
        kind="Order"
        title={COPY.newOrder}
        subtitle={COPY.newSubtitle}
        edit={created ? undefined : { title: "Order details", readOnly: !canCreate, form }}
      >
        {created ? (
          <PaymentLinkPanel
            link={created}
            heading={COPY.created(created.orderId)}
            actions={
              <>
                <AdminAction size="sm" variant="primary" icon="receipt_long" onClick={() => openOrder(created.orderId)}>
                  {COPY.openOrder}
                </AdminAction>
                <AdminAction size="sm" icon="add" onClick={reset}>
                  {COPY.createAnother}
                </AdminAction>
              </>
            }
          />
        ) : null}
      </AdminDrawer>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={COPY.confirmTitle(total ?? formatINR(rupeesToPaise(draft.amount) ?? 0, { exact: true }))}
        description={COPY.confirmBody}
        confirmLabel={COPY.recordPayment}
        tone="primary"
        icon="payments"
        requireReason={false}
        onConfirm={recordOffline}
      />
    </>
  );
}
