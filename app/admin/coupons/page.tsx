import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { CouponsView } from "@/components/admin/coupons/coupons-view";
import { NewCouponAction } from "@/components/admin/coupons/new-coupon";
import { AdminModulePage } from "@/components/admin/module-page";
import { PageSkeletonTable } from "@/components/admin/coupons/table-skeleton";
import { istDateOf } from "@/lib/admin/coupons/model";
import { loadCoupons } from "@/lib/admin/coupons/service";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("coupons");

/** Loads every coupon on the server (any staff role may view; changes need coupons.manage). */
async function CouponsSection() {
  const now = new Date();
  const { coupons, products } = await loadCoupons(db, now);
  return (
    <Suspense fallback={<PageSkeletonTable />}>
      <CouponsView coupons={coupons} products={products} today={istDateOf(now)} />
    </Suspense>
  );
}

/** Admin > Coupons & promotions (Admin Console.dc.html #coupons). */
export default function AdminCouponsPage() {
  return (
    <AdminModulePage
      moduleKey="coupons"
      actions={
        <Suspense fallback={null}>
          <NewCouponAction />
        </Suspense>
      }
    >
      <CouponsSection />
    </AdminModulePage>
  );
}
