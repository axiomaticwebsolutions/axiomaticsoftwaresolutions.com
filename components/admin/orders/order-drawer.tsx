"use client";

import Link from "next/link";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction, type DestructiveConfirmInput } from "@/components/admin/destructive-action";
import { AdminDrawer, type AdminDrawerSection, type AdminField } from "@/components/admin/drawer";
import { SectionBody, SectionRow, SectionRows } from "@/components/admin/section";
import { statusMeta, StatusBadge } from "@/components/admin/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  discountLabel,
  drawerItemLabel,
  formatShortDateTimeIST,
  gstSplitLabel,
  itemKindLabel,
  money,
  orderApiPath,
  orderInvoicePdfPath,
  orderRefundPath,
  orderResendPath,
  orderReviewPath,
  ORDERS_COPY,
  paymentTone,
  providerLabel,
  refundConsequence,
  refundTitle,
  refundToast,
  refundTone,
  replayToast,
  webhookReplayPath,
  webhookTone,
  type AdminOrderDetail,
  type AdminOrderPayment,
  type RefundResponse,
  type ReplayResponse,
  type ResendResponse,
} from "@/lib/admin/orders/model";
import { apiFetch } from "@/lib/client/api";

const LINK = "rounded-6 font-bold text-primary-link no-underline hover:text-primary-link-hover hover:underline";

/** "Refund duplicate payment" on a payment row (decisions.md Phase 6 build decisions, 2026-10-07 night). New copy (owner review). */
const DUPLICATE_REFUND_COPY = {
  trigger: "Refund duplicate payment",
  confirm: "Refund payment",
  detail: (refundablePaise: number) => `Duplicate payment \u00B7 ${money(refundablePaise)} refundable`,
  detailSettled: "Duplicate payment",
  title: (refundablePaise: number, orderId: string) => `Refund the duplicate payment of ${money(refundablePaise)} for ${orderId}?`,
  consequence:
    "Returns this payment through the payment provider. The order, its invoice and its licenses don\u2019t change, and no credit note is generated.",
} as const;

/** A captured payment that did not pay the order and still has money to return. */
function canRefundDuplicate(payment: Pick<AdminOrderPayment, "duplicate" | "refundablePaise">): boolean {
  return payment.duplicate && payment.refundablePaise > 0;
}

type Load = { status: "idle" | "loading" | "error"; order: AdminOrderDetail | null; error?: string };

/** Loads GET /api/admin/orders/:id for the open drawer; `reload` refetches after an action. */
function useOrderDetail(id: string | null): Load & { reload: () => void } {
  const [state, setState] = React.useState<Load>({ status: "idle", order: null });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState((s) => ({ status: "loading", order: s.order?.id === id ? s.order : null }));
    apiFetch<{ order: AdminOrderDetail }>(orderApiPath(id), { signal: controller.signal })
      .then(({ order }) => setState({ status: "idle", order }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", order: null, error: error instanceof Error && error.message ? error.message : ORDERS_COPY.detailError });
      });
    return () => controller.abort();
  }, [id, nonce]);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

function billedTo(order: AdminOrderDetail): React.ReactNode {
  const b = order.billing;
  const place = [b.address, b.city, [b.state, b.pin].filter(Boolean).join(" ")].filter((p) => p && p.trim()).join(", ");
  const lines = [b.name, place].filter(Boolean).join(" \u00B7 ");
  return (
    <>
      {lines || "\u2014"}
      {order.accountId ? (
        <>
          {" "}
          <Link href={`/admin/customers?id=${encodeURIComponent(order.accountId)}`} className={`${LINK} whitespace-nowrap text-[12.5px]`}>
            Open account
          </Link>
        </>
      ) : null}
    </>
  );
}

function fieldsOf(order: AdminOrderDetail): AdminField[] {
  return [
    { label: "Customer", value: order.customer },
    { label: "GSTIN", value: order.gstin ?? ORDERS_COPY.unregistered, mono: true },
    { label: "Place of supply", value: order.placeOfSupply },
    { label: "Invoice", value: order.invoice?.number ?? ORDERS_COPY.notIssued, mono: true },
    { label: "Subtotal", value: money(order.subtotalPaise) },
    { label: "Discount", value: discountLabel(order.discountPaise, order.couponCode) },
    { label: "Taxable value", value: money(order.taxablePaise) },
    { label: "GST", value: gstSplitLabel(order) },
    { label: "Total", value: money(order.totalPaise) },
    { label: "Paid at", value: formatShortDateTimeIST(order.paidAt) },
    { label: "Billed to", value: billedTo(order), wide: true },
  ];
}

type SectionOptions = {
  testMode: boolean;
  replaying: string | null;
  onReplay: (eventId: string, provider: string) => void;
  /** Refunds one duplicate payment (POST .../refund with `paymentId`). */
  onRefundDuplicate: (paymentId: string, input: DestructiveConfirmInput) => Promise<void>;
};

function paymentDetail(order: AdminOrderDetail, p: AdminOrderPayment, opts: SectionOptions): React.ReactNode {
  const line = [
    `Provider: ${providerLabel(p.provider, opts.testMode)}`,
    formatShortDateTimeIST(p.createdAt),
    p.failureReason,
    p.duplicate ? (p.refundablePaise > 0 ? DUPLICATE_REFUND_COPY.detail(p.refundablePaise) : DUPLICATE_REFUND_COPY.detailSettled) : null,
  ]
    .filter(Boolean)
    .join(" \u00B7 ");
  if (!canRefundDuplicate(p)) return line;
  const reference = p.providerPaymentId ?? p.providerOrderId;
  return (
    <>
      {line}
      {/* Below the text rather than beside it: the label is long and the drawer is narrow on phones. */}
      <div className="mt-1.5">
        <DestructiveAction
          actionKey="orders.refund"
          targetId={order.id}
          size="xs"
          triggerLabel={
            <>
              {DUPLICATE_REFUND_COPY.trigger}
              <span className="sr-only"> {reference}</span>
            </>
          }
          title={DUPLICATE_REFUND_COPY.title(p.refundablePaise, order.id)}
          consequence={DUPLICATE_REFUND_COPY.consequence}
          confirmLabel={DUPLICATE_REFUND_COPY.confirm}
          onConfirm={(input) => opts.onRefundDuplicate(p.id, input)}
        />
      </div>
    </>
  );
}

function sectionsOf(order: AdminOrderDetail, opts: SectionOptions): AdminDrawerSection[] {
  const sections: AdminDrawerSection[] = [];
  if (order.status === "review") {
    sections.push({
      id: "review",
      title: ORDERS_COPY.reviewTitle,
      content: (
        <SectionBody>
          <p className="m-0 text-[13px] font-semibold text-peach-fg">{order.failReason ?? "Check this order before it moves on."}</p>
        </SectionBody>
      ),
    });
  }
  sections.push({
    id: "items",
    title: "Items",
    content: (
      <SectionRows>
        {order.items.map((item) => (
          <SectionRow
            key={item.id}
            title={drawerItemLabel(item.product, item.plan, item.quantity)}
            detail={
              item.issuedLicenseId ? (
                <Link href={`/admin/licenses?id=${encodeURIComponent(item.issuedLicenseId)}`} className={LINK}>
                  License {item.issuedLicenseId}
                </Link>
              ) : (
                itemKindLabel(item.kind, item.targetLicenseId)
              )
            }
            status={money(item.linePaise)}
          />
        ))}
      </SectionRows>
    ),
  });
  sections.push({
    id: "payments",
    title: "Payments",
    empty: ORDERS_COPY.paymentsEmpty,
    content: order.payments.length ? (
      <SectionRows>
        {order.payments.map((p) => (
          <SectionRow
            key={p.id}
            title={
              <>
                <span className="font-mono text-[12.5px]">{p.providerPaymentId ?? p.providerOrderId}</span>{" \u00B7 "}{p.method ?? "\u2014"}
              </>
            }
            detail={paymentDetail(order, p, opts)}
            status={p.status}
            tone={paymentTone(p.status)}
          />
        ))}
      </SectionRows>
    ) : null,
  });
  if (order.refunds.length > 0) {
    sections.push({
      id: "refunds",
      title: "Refunds",
      content: (
        <SectionRows>
          {order.refunds.map((r) => (
            <SectionRow
              key={r.id}
              title={
                <>
                  {money(r.amountPaise)}{" \u00B7 "}<span className="font-mono text-[12.5px]">{r.creditNoteNo ?? "No credit note"}</span>
                </>
              }
              detail={`${r.createdBy ?? "Staff"} \u00B7 ${formatShortDateTimeIST(r.createdAt)} \u00B7 ${r.reason}`}
              status={statusMeta("refund", r.status).label}
              tone={refundTone(r.status)}
            />
          ))}
        </SectionRows>
      ),
    });
  }
  sections.push({
    id: "webhooks",
    title: "Webhook events",
    empty: ORDERS_COPY.webhooksEmpty,
    content: order.webhooks.length ? (
      <SectionRows>
        {order.webhooks.map((w) => (
          <SectionRow
            key={w.id}
            title={
              <>
                <span className="whitespace-nowrap">{w.type ?? "unknown"}</span>{" \u00B7 "}
                <span className="break-all">{w.eventId ?? "\u2014"}</span>
              </>
            }
            detail={`${formatShortDateTimeIST(w.receivedAt)}${w.replayedBy ? ` \u00B7 replayed by ${w.replayedBy}` : ""}`}
            status={w.result}
            tone={webhookTone(w.result)}
            action={
              w.replayable && w.eventId ? (
                <AdminAction
                  perm="payments.replay"
                  size="xs"
                  busy={opts.replaying === w.eventId}
                  onClick={() => opts.onReplay(w.eventId as string, w.provider)}
                  aria-label={`Replay ${w.eventId}`}
                >
                  Replay
                </AdminAction>
              ) : null
            }
          />
        ))}
      </SectionRows>
    ) : null,
  });
  sections.push({
    id: "licenses",
    title: "Licenses issued",
    empty: ORDERS_COPY.licensesEmpty,
    content: order.licenses.length ? (
      <SectionRows>
        {order.licenses.map((l) => (
          <SectionRow
            key={l.id}
            title={
              <Link href={`/admin/licenses?id=${encodeURIComponent(l.id)}`} className="rounded-6 text-ink no-underline hover:underline">
                {l.id}{" \u00B7 "}<span className="font-mono text-[12.5px]">{l.maskedKey}</span>
              </Link>
            }
            detail={l.product}
            status={statusMeta("license", l.status).label}
          />
        ))}
      </SectionRows>
    ) : null,
  });
  sections.push({
    id: "history",
    title: "History",
    empty: ORDERS_COPY.historyEmpty,
    content: order.history.length ? (
      <SectionRows>
        {order.history.map((h) => (
          <SectionRow
            key={h.id}
            title={h.action}
            detail={[`${h.actor} \u00B7 ${formatShortDateTimeIST(h.at)}`, h.reason ? `Reason: ${h.reason}` : null, h.detail].filter(Boolean).join(" \u00B7 ")}
          />
        ))}
      </SectionRows>
    ) : null,
  });
  return sections;
}

export type OrderDrawerProps = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a refund, review, resend or replay: refresh the list and stats. */
  onChanged: () => void;
};

/**
 * The order drawer (Admin Console.dc.html "ORDER"): facts grid, items, payments (a duplicate captured payment offers
 * "Refund duplicate payment": refunds.issue, reason + typed order id, POST .../refund with `paymentId`), refunds,
 * webhook events with Replay (payments.replay), licenses issued, history; footer View invoice, Resend invoice, Issue
 * refund (refunds.issue, reason + typed order id) and, for orders in review, Mark reviewed (Owner / Finance, reason).
 */
export function OrderDrawer({ id, open, onOpenChange, onChanged }: OrderDrawerProps) {
  const { testMode } = useAdmin();
  const detail = useOrderDetail(open ? id : null);
  const order = detail.order && detail.order.id === id ? detail.order : null;
  const [replaying, setReplaying] = React.useState<string | null>(null);
  const [resending, setResending] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  const changed = () => {
    detail.reload();
    onChanged();
  };

  const replay = async (eventId: string, provider: string) => {
    setReplaying(eventId);
    try {
      const result = await apiFetch<ReplayResponse>(webhookReplayPath(eventId), { method: "POST", body: { provider } });
      adminToast.success(replayToast(result));
      changed();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setReplaying(null);
    }
  };

  const resend = async () => {
    if (!order) return;
    setResending(true);
    try {
      await apiFetch<ResendResponse>(orderResendPath(order.id), { method: "POST", body: {} });
      adminToast.success("Invoice email queued");
      changed();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setResending(false);
    }
  };

  const refund = async ({ reason, confirmId }: { reason: string; confirmId?: string }) => {
    if (!order) return;
    const result = await apiFetch<RefundResponse>(orderRefundPath(order.id), { method: "POST", body: { reason, confirmId } });
    adminToast.success(refundToast(result));
    changed();
  };

  const refundDuplicate = async (paymentId: string, { reason, confirmId }: DestructiveConfirmInput) => {
    if (!order) return;
    const result = await apiFetch<RefundResponse>(orderRefundPath(order.id), { method: "POST", body: { reason, confirmId, paymentId } });
    adminToast.success(refundToast({ ...result, duplicate: true }));
    changed();
  };

  const review = async ({ reason }: { reason: string }) => {
    if (!order) return;
    await apiFetch<{ status: string }>(orderReviewPath(order.id), { method: "POST", body: { reason } });
    adminToast.success(ORDERS_COPY.markReviewedDone);
    changed();
  };

  const footer = order ? (
    <>
      <AdminAction
        size="sm"
        icon="description"
        href={order.invoice ? orderInvoicePdfPath(order.id) : undefined}
        newTab
        disabledReason={order.invoice ? undefined : ORDERS_COPY.invoiceUnavailable}
      >
        {ORDERS_COPY.viewInvoice}
      </AdminAction>
      {order.invoice ? (
        <AdminAction size="sm" icon="outgoing_mail" perm="orders.resend_invoice" busy={resending} onClick={resend}>
          {ORDERS_COPY.resendInvoice}
        </AdminAction>
      ) : null}
      {order.status === "review" ? (
        <AdminAction size="sm" icon="task_alt" perm="refunds.issue" onClick={() => setReviewOpen(true)} aria-haspopup="dialog">
          {ORDERS_COPY.markReviewed}
        </AdminAction>
      ) : null}
      {order.refund.allowed ? (
        <DestructiveAction
          actionKey="orders.refund"
          targetId={order.id}
          title={refundTitle(order.refund.amountPaise, order.id)}
          consequence={refundConsequence(order.refund)}
          onConfirm={refund}
        />
      ) : null}
    </>
  ) : null;

  return (
    <>
      <AdminDrawer
        open={open}
        onOpenChange={onOpenChange}
        kind="Order"
        title={id ?? ""}
        status={order ? <StatusBadge kind="order" status={order.status} /> : undefined}
        subtitle={order ? `${formatShortDateTimeIST(order.createdAt)} \u00B7 ${order.email}` : undefined}
        loading={!order && detail.status !== "error"}
        error={detail.status === "error" ? (detail.error ?? ORDERS_COPY.detailError) : undefined}
        fields={order ? fieldsOf(order) : undefined}
        sections={order ? sectionsOf(order, { testMode, replaying, onReplay: replay, onRefundDuplicate: refundDuplicate }) : undefined}
        footer={footer}
      />
      {order ? (
        <ConfirmDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          title={`${ORDERS_COPY.markReviewed}: ${order.id}?`}
          description={ORDERS_COPY.markReviewedBody}
          confirmLabel={ORDERS_COPY.markReviewed}
          tone="primary"
          icon="task_alt"
          requireReason
          onConfirm={review}
        />
      ) : null}
    </>
  );
}
