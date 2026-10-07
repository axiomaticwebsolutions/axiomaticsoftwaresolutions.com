"use client";

import Link from "next/link";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { toast } from "@/components/ui/sonner";
import { COUPON_COPY, couponDiscountValue, couponRedemptionsText, type CouponDto } from "@/lib/admin/coupons/model";
import { apiFetch } from "@/lib/client/api";
import { formatDateIST, formatDateTimeIST } from "@/lib/dates";
import { couponBody, couponDraft, couponPatch, type CouponDraft } from "./coupon-draft";
import { CouponForm, type CouponProductOption } from "./coupon-form";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "./form-errors";

type CouponOrderRow = { id: string; createdAt: string; status: string; discountLabel: string };
type CouponDetail = { coupon: CouponDto; orders: CouponOrderRow[]; orderCount: number };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The drawer's ?id= (the coupon code). */
  code: string | null;
  coupon: CouponDto | null;
  products: readonly CouponProductOption[];
  today: string;
  /** Re-reads the list after a change (router.refresh). */
  onChanged: () => void;
  /** After a delete: closes the drawer and re-reads the list. */
  onDeleted: () => void;
};

type DetailState = { code: string | null; detail: CouponDetail | null; failed: boolean };

/** GET /api/admin/coupons/:code while the drawer is open (again after each change). */
function useCouponDetail(code: string | null, version: number): { detail: CouponDetail | null; failed: boolean } {
  const [state, setState] = React.useState<DetailState>({ code: null, detail: null, failed: false });
  React.useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    apiFetch<CouponDetail>(`/api/admin/coupons/${encodeURIComponent(code)}`, { signal: controller.signal })
      .then((detail) => setState({ code, detail, failed: false }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ code, detail: null, failed: true });
      });
    return () => controller.abort();
  }, [code, version]);
  return state.code === code ? { detail: state.detail, failed: state.failed } : { detail: null, failed: false };
}

function OrdersSection({ coupon, detail }: { coupon: CouponDto; detail: CouponDetail | null }) {
  if (!detail || detail.orders.length === 0) return null;
  return (
    <SectionRows aria-label={`Orders that used ${coupon.code}`}>
      {detail.orders.map((o) => (
        <SectionRow
          key={o.id}
          title={
            <Link href={`/admin/orders?id=${encodeURIComponent(o.id)}`} className="font-mono text-[12.5px] text-primary-link underline-offset-2 hover:underline">
              {o.id}
            </Link>
          }
          detail={formatDateTimeIST(new Date(o.createdAt))}
          status={<StatusBadge kind="order" status={o.status} />}
          action={<span className="whitespace-nowrap text-[12.5px] font-bold">{o.discountLabel}</span>}
        />
      ))}
    </SectionRows>
  );
}

/** Coupon drawer (prototype COUPON): facts, the "Rules" form (read only without coupons.manage), recent orders, and Pause / Activate / Delete. */
export function CouponDrawer({ open, onOpenChange, code, coupon, products, today, onChanged, onDeleted }: Props) {
  const canManage = useCan("coupons.manage");
  const [version, setVersion] = React.useState(0);
  const { detail, failed } = useCouponDetail(open ? code : null, version);
  const [draft, setDraft] = React.useState<CouponDraft>(() => couponDraft(coupon, today));
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState<"save" | "toggle" | null>(null);

  // Another coupon, or fresh data after a save: the form starts again from the stored values.
  const stored = coupon ? `${coupon.code}:${coupon.updatedAt}` : "none";
  const [formFor, setFormFor] = React.useState(stored);
  if (formFor !== stored) {
    setFormFor(stored);
    setDraft(couponDraft(coupon, today));
    setErrors(NO_ERRORS);
  }

  const changed = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  async function save() {
    if (!coupon) return;
    const { body, errors: local } = couponBody(draft);
    if (Object.keys(local).length > 0) return setErrors({ fields: local, form: null });
    const patch = couponPatch(coupon, body);
    if (Object.keys(patch).length === 0) {
      setErrors(NO_ERRORS);
      toast.success(COUPON_COPY.noChanges);
      return;
    }
    setBusy("save");
    try {
      await apiFetch(`/api/admin/coupons/${encodeURIComponent(coupon.code)}`, { method: "PATCH", body: patch });
      setErrors(NO_ERRORS);
      toast.success(COUPON_COPY.saved);
      changed();
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(active: boolean) {
    if (!coupon) return;
    setBusy("toggle");
    try {
      await apiFetch(`/api/admin/coupons/${encodeURIComponent(coupon.code)}/${active ? "activate" : "pause"}`, { method: "POST" });
      toast.success(active ? COUPON_COPY.activated : COUPON_COPY.paused);
      changed();
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  }

  const used = coupon ? Math.max(coupon.redemptions, detail?.orderCount ?? 0) : 0;
  const ordersTitle =
    detail && detail.orderCount > detail.orders.length ? `Recent orders (${detail.orderCount.toLocaleString("en-IN")} in all)` : "Recent orders";
  const ordersEmpty = failed ? "Couldn\u2019t load the orders. Reopen the coupon to try again." : detail ? "No orders have used this code yet." : "Loading\u2026";

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Coupon"
      title={coupon?.code ?? code ?? "Coupon"}
      status={coupon ? <StatusBadge kind="coupon" status={coupon.status} /> : undefined}
      subtitle={coupon?.scope}
      error={open && !coupon ? "This coupon doesn\u2019t exist. It may have been deleted." : undefined}
      fields={
        coupon
          ? [
              { label: "Discount", value: couponDiscountValue(coupon.type, coupon.value) },
              { label: "Redemptions", value: couponRedemptionsText(coupon) },
              { label: "Starts", value: formatDateIST(new Date(coupon.startsAt)) },
              { label: "Ends", value: formatDateIST(new Date(coupon.endsAt)) },
              { label: "Stacking", value: COUPON_COPY.stacking },
              { label: "Applied", value: COUPON_COPY.applied },
              { label: "Checkout label", value: coupon.label, wide: true },
            ]
          : undefined
      }
      edit={
        coupon
          ? {
              title: "Rules",
              readOnly: !canManage,
              form: (
                <CouponForm
                  mode="edit"
                  draft={draft}
                  onChange={setDraft}
                  products={products}
                  errors={errors.fields}
                  formError={errors.form}
                  busy={busy === "save"}
                  onSubmit={save}
                  idPrefix={`coupon-${coupon.code}`}
                />
              ),
            }
          : undefined
      }
      sections={
        coupon ? [{ id: "orders", title: ordersTitle, empty: ordersEmpty, content: detail && detail.orders.length > 0 ? <OrdersSection coupon={coupon} detail={detail} /> : null }] : undefined
      }
      footer={
        coupon ? (
          <>
            {coupon.active ? (
              <AdminAction perm="coupons.manage" size="sm" icon="pause" busy={busy === "toggle"} onClick={() => toggle(false)}>
                Pause
              </AdminAction>
            ) : (
              <AdminAction perm="coupons.manage" size="sm" variant="primary" icon="play_arrow" busy={busy === "toggle"} onClick={() => toggle(true)}>
                Activate
              </AdminAction>
            )}
            <DestructiveAction
              actionKey="coupons.delete"
              targetId={coupon.code}
              consequence={COUPON_COPY.deleteConsequence}
              disabledReason={used > 0 ? COUPON_COPY.usedCannotDelete(coupon.code, used) : undefined}
              successMessage={COUPON_COPY.deleted}
              onConfirm={async ({ reason, confirmId }) => {
                await apiFetch(`/api/admin/coupons/${encodeURIComponent(coupon.code)}`, { method: "DELETE", body: { reason, confirmId } });
                onDeleted();
              }}
            />
          </>
        ) : undefined
      }
    />
  );
}
