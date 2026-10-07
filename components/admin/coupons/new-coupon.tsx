"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { AdminDrawer } from "@/components/admin/drawer";
import { withParam } from "@/components/admin/model";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { toast } from "@/components/ui/sonner";
import { COUPON_COPY, type CouponDto } from "@/lib/admin/coupons/model";
import { apiFetch } from "@/lib/client/api";
import { couponBody, couponDraft, type CouponDraft } from "./coupon-draft";
import { CouponForm, type CouponProductOption } from "./coupon-form";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "./form-errors";

/** URL parameter of the "New coupon" drawer (?new=1). */
export const NEW_PARAM = "new";

/** Header action "New coupon" (coupons.manage): opens the create drawer. */
export function NewCouponAction() {
  const create = useDrawerParam(NEW_PARAM);
  return (
    <AdminAction perm="coupons.manage" variant="primary" icon="add" onClick={() => create.open("1")} aria-haspopup="dialog">
      {COUPON_COPY.newCoupon}
    </AdminAction>
  );
}

type Props = { open: boolean; onOpenChange: (open: boolean) => void; products: readonly CouponProductOption[]; today: string };

/**
 * "New coupon" drawer: the full rules form plus the code. The coupon is created paused (prototype "Draft coupon
 * created (paused)"); the drawer then shows it so it can be checked and activated.
 */
export function NewCouponDrawer({ open, onOpenChange, products, today }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const canManage = useCan("coupons.manage");
  const [draft, setDraft] = React.useState<CouponDraft>(() => couponDraft(null, today));
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(couponDraft(null, today));
      setErrors(NO_ERRORS);
    }
  }

  async function create() {
    const { body, errors: local } = couponBody(draft);
    if (Object.keys(local).length > 0) return setErrors({ fields: local, form: null });
    setBusy(true);
    try {
      const { coupon } = await apiFetch<{ coupon: CouponDto }>("/api/admin/coupons", { method: "POST", body });
      toast.success(COUPON_COPY.created);
      // Swap ?new=1 for ?id=<code>: the new coupon's drawer, with fresh server data.
      const search = withParam(withParam(window.location.search, NEW_PARAM, null), "id", coupon.code);
      router.replace(`${pathname}${search}`, { scroll: false });
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Coupon"
      title={COUPON_COPY.newCoupon}
      subtitle="New coupons start paused. Activate it when it’s ready."
      edit={{
        title: "Rules",
        readOnly: !canManage,
        form: (
          <CouponForm
            mode="create"
            draft={draft}
            onChange={setDraft}
            products={products}
            errors={errors.fields}
            formError={errors.form}
            busy={busy}
            onSubmit={create}
            idPrefix="coupon-new"
          />
        ),
      }}
    />
  );
}
