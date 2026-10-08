"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DrawerSubmit, type AdminDrawerEdit } from "@/components/admin/drawer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  orderApiPath,
  orderCorrectBillingPath,
  orderPaymentLinkPath,
  type AdminOrderDetail,
} from "@/lib/admin/orders/model";
import {
  billingDraftFromSnapshot,
  ORDER_RECORD_COPY as COPY,
  orderFormErrors,
  orderItemsPayload,
  type AdminOrderPlanOption,
  type OrderBillingDraft,
  type OrderLineDraft,
} from "@/lib/admin/orders/records-model";
import { apiFetch } from "@/lib/client/api";
import {
  CouponField,
  emptyLine,
  OrderBillingFields,
  OrderErrorSummary,
  orderErrorsFrom,
  OrderFormAlert,
  OrderItemsEditor,
  OrderReasonField,
  OrderSummary,
  PaymentLinkPanel,
  useCustomerDetail,
  useOrderQuote,
  type PaymentLinkView,
} from "./order-form";

type FormErrors = { fields: Record<string, string>; form: string | null };
const NO_ERRORS: FormErrors = { fields: {}, form: null };

/** The order's billing snapshot as form fields. */
export function orderBillingDraft(order: AdminOrderDetail): OrderBillingDraft {
  return billingDraftFromSnapshot({ ...order.billing, email: order.billingEmail, gstin: order.gstin });
}

function linesOf(order: AdminOrderDetail): OrderLineDraft[] {
  return order.items.map((i) => ({ ...emptyLine(), planId: i.planId, kind: i.kind, targetLicenseId: i.targetLicenseId ?? "", qty: String(i.quantity) }));
}

// ---------- Edit an unpaid order ----------

function OrderEditForm({
  order,
  plans,
  onSaved,
  onLink,
}: {
  order: AdminOrderDetail;
  plans: readonly AdminOrderPlanOption[];
  onSaved: () => void;
  /** A new payment link after an email change (held by useOrderEdit, outside this keyed form, so a reload keeps it). */
  onLink: (link: PaymentLinkView | null) => void;
}) {
  const prefix = `order-edit-${order.id}`;
  const [lines, setLines] = React.useState<OrderLineDraft[]>(() => linesOf(order));
  const [couponCode, setCouponCode] = React.useState(order.couponCode ?? "");
  const [billing, setBilling] = React.useState<OrderBillingDraft>(() => orderBillingDraft(order));
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);
  const customer = useCustomerDetail(order.accountId);
  const quote = useOrderQuote({ orderId: order.id }, lines, plans, couponCode, billing.state);
  const legacyPlans = React.useMemo(() => Object.fromEntries(order.items.map((i) => [i.planId, `${i.product} · ${i.plan}`])), [order.items]);
  const original = React.useMemo(
    () => ({ items: JSON.stringify(orderItemsPayload(linesOf(order), plans)), coupon: order.couponCode ?? "", billing: JSON.stringify(orderBillingDraft(order)) }),
    [order, plans],
  );

  async function save() {
    if (busy) return;
    const items = orderItemsPayload(lines, plans);
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(items) !== original.items) patch.items = items;
    if (couponCode.trim() !== original.coupon) patch.couponCode = couponCode.trim() || null;
    if (JSON.stringify(billing) !== original.billing) patch.billing = billing;
    if (Object.keys(patch).length === 0) {
      setErrors(NO_ERRORS);
      adminToast.success(COPY.noChanges);
      return;
    }
    const local = orderFormErrors(
      { lines, couponCode, billing, mode: "link", method: "cash", reference: "", receivedOn: "", amount: "", reason },
      plans,
      { needCustomer: false, hasCustomer: true, payment: false, now: new Date() },
    );
    if (Object.keys(local).length > 0) return setErrors({ fields: local, form: null });
    setBusy(true);
    try {
      const result = await apiFetch<{ changed: boolean; paymentUrl: string }>(orderApiPath(order.id), {
        method: "PATCH",
        body: { ...patch, reason: reason.trim() },
      });
      setErrors(NO_ERRORS);
      if (!result.changed) {
        adminToast.success(COPY.noChanges);
        return;
      }
      adminToast.success(COPY.updated);
      setReason("");
      // Links are bound to the order email: after an email change the old link stops working, so show the new one.
      onLink(
        billing.email.trim().toLowerCase() !== order.billingEmail.toLowerCase()
          ? { url: result.paymentUrl, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), email: billing.email.trim() }
          : null,
      );
      onSaved();
    } catch (error) {
      setErrors(orderErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <OrderErrorSummary prefix={prefix} fields={errors.fields} />
      <OrderFormAlert>{errors.form}</OrderFormAlert>
      <OrderItemsEditor
        prefix={prefix}
        lines={lines}
        onChange={setLines}
        plans={plans}
        licenses={customer.customer?.licenses ?? []}
        errors={errors.fields}
        quote={quote.quote}
        legacyPlans={legacyPlans}
      />
      <CouponField prefix={prefix} value={couponCode} onChange={setCouponCode} error={errors.fields.couponCode} quote={quote.quote} />
      <OrderBillingFields prefix={prefix} billing={billing} onChange={setBilling} errors={errors.fields} />
      <OrderSummary quote={quote.quote} loading={quote.loading} error={quote.error} emptyText={COPY.summaryEmptyEdit} />
      <OrderReasonField prefix={prefix} value={reason} error={errors.fields.reason} onChange={setReason} />
      <DrawerSubmit loading={busy}>{COPY.saveChanges}</DrawerSubmit>
    </form>
  );
}

/**
 * The drawer's "Edit order" card (orders.edit): unpaid orders only. Read only with a note for roles without the
 * permission, and for orders that are paid, settling or cancelled by staff (the note says why). The payment link an
 * email change produces is kept here, above the keyed form: saving reloads the order, which remounts the form.
 */
export function useOrderEdit(order: AdminOrderDetail | null, plans: readonly AdminOrderPlanOption[], onSaved: () => void): AdminDrawerEdit | undefined {
  const canEdit = useCan("orders.edit");
  const orderId = order?.id ?? null;
  const [link, setLink] = React.useState<{ orderId: string; view: PaymentLinkView } | null>(null);
  const shown = link && link.orderId === orderId ? link.view : null;
  if (!order) return undefined;
  if (order.edit.reason === null && !order.edit.allowed) return undefined;
  const locked = !canEdit || !order.edit.allowed;
  return {
    title: COPY.editTitle,
    readOnly: locked,
    readOnlyNote: !canEdit ? COPY.editReadOnly : "Can’t be edited",
    form: locked ? (
      <p className="m-0 text-[13px] text-ink-2">{!canEdit ? COPY.editRolesNote : order.edit.reason}</p>
    ) : (
      <>
        {/* An edit never emails the link, so the panel says how long it works instead of "We’ll email it". */}
        {shown ? <PaymentLinkPanel link={shown} heading={COPY.paymentLink} note={false} /> : null}
        <OrderEditForm
          key={`${order.id}:${order.totalPaise}:${order.billingEmail}:${order.couponCode ?? ""}`}
          order={order}
          plans={plans}
          onSaved={onSaved}
          onLink={(view) => setLink(view ? { orderId: order.id, view } : null)}
        />
      </>
    ),
  };
}

// ---------- Payment link ----------

/** "Payment link" (orders.create): fetches a fresh link, Copy link, and "Email it to …". */
export function PaymentLinkAction({ order }: { order: AdminOrderDetail }) {
  const [open, setOpen] = React.useState(false);
  const [link, setLink] = React.useState<PaymentLinkView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const errorRef = React.useRef<HTMLParagraphElement>(null);
  // A refusal (not payable, rate limit, network) takes focus, so keyboard users hear it and stay inside the dialog.
  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function load() {
    setLink(null);
    setError(null);
    try {
      const r = await apiFetch<{ url: string; expiresAt: string }>(orderPaymentLinkPath(order.id), { method: "POST", body: { send: false } });
      setLink({ url: r.url, expiresAt: r.expiresAt, email: order.billingEmail });
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn’t create the link.");
    }
  }

  async function send() {
    setSending(true);
    try {
      await apiFetch(orderPaymentLinkPath(order.id), { method: "POST", body: { send: true } });
      adminToast.success(COPY.linkEmailedToast);
    } catch (e) {
      adminToast.error(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <AdminAction
        size="sm"
        icon="payments"
        perm="orders.create"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        {COPY.paymentLink}
      </AdminAction>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setLink(null);
        }}
      >
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className="leading-[normal] focus:outline-none"
          onOpenAutoFocus={(e) => {
            // Focus the dialog itself while the link loads; the link panel (or the error) takes it when it appears.
            e.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{COPY.paymentLinkTitle(order.id)}</DialogTitle>
            <DialogDescription className="text-[13.5px]">{COPY.paymentLinkBody}</DialogDescription>
          </DialogHeader>
          {link ? (
            <PaymentLinkPanel
              link={link}
              note={false}
              actions={
                <AdminAction size="sm" icon="outgoing_mail" busy={sending} onClick={send}>
                  {COPY.emailIt(order.billingEmail)}
                </AdminAction>
              }
            />
          ) : error ? (
            <p ref={errorRef} tabIndex={-1} role="alert" className="m-0 text-[13px] font-semibold text-danger focus:outline-none">
              {error}
            </p>
          ) : (
            <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
              <Spinner size="sm" /> {"Creating the link…"}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" size="sm">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------- Correct billing ----------

/** "Correct billing" (invoices.correct): the billing fields (state and email read only), a reason, the consequence. */
export function CorrectBillingAction({ order, onDone }: { order: AdminOrderDetail; onDone: () => void }) {
  const [open, setOpen] = React.useState(false);
  const prefix = `order-correct-${order.id}`;
  const [billing, setBilling] = React.useState<OrderBillingDraft>(() => orderBillingDraft(order));
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);

  function start() {
    setBilling(orderBillingDraft(order));
    setReason("");
    setErrors(NO_ERRORS);
    setOpen(true);
  }

  async function submit() {
    if (busy) return;
    if (reason.trim().length < 4) return setErrors({ fields: { reason: "Add a short reason for the audit log." }, form: null });
    setBusy(true);
    try {
      const { name, phone, business, address, city, pin, gstin } = billing;
      const result = await apiFetch<{ correction: { creditNoteNo: string; newInvoiceNo: string } }>(orderCorrectBillingPath(order.id), {
        method: "POST",
        body: { billing: { name, phone, business, address, city, pin, gstin }, reason: reason.trim() },
      });
      adminToast.success(`${COPY.corrected(result.correction.creditNoteNo, result.correction.newInvoiceNo)}. ${COPY.resendSuggestion}`);
      setOpen(false);
      onDone();
    } catch (error) {
      setErrors(orderErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  const disabledReason = order.correction.allowed ? undefined : (order.correction.reason ?? undefined);
  return (
    <>
      <AdminAction size="sm" icon="edit_document" perm="invoices.correct" disabledReason={disabledReason} aria-haspopup="dialog" onClick={start}>
        {COPY.correctBilling}
      </AdminAction>
      <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto leading-[normal]">
          <DialogHeader>
            <DialogTitle>{COPY.correctTitle(order.id)}</DialogTitle>
            <DialogDescription className="text-[13.5px]">{COPY.correctConsequence(order.invoice?.number ?? "")}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void submit();
            }}
          >
            <OrderErrorSummary prefix={prefix} fields={errors.fields} />
            <OrderFormAlert>{errors.form}</OrderFormAlert>
            <OrderBillingFields prefix={prefix} billing={billing} onChange={setBilling} errors={errors.fields} locked />
            <OrderReasonField prefix={prefix} value={reason} error={errors.fields.reason} onChange={setReason} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary" size="sm" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                {COPY.correctConfirm}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
