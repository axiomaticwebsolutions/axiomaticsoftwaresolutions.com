/**
 * Data the "New order" form needs (server-only): the plans staff can sell. Prices are shown for orientation only; the
 * server re-prices every request with checkout's priceCart.
 */
import "server-only";
import { PlanType, PublishStatus } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import type { AdminOrderPlanOption } from "./records-model";

/**
 * Plans that are not archived and not trials, of published or hidden products (not drafts, and not COMING_SOON ones,
 * which checkout refuses for every item kind), by product then plan order.
 */
export async function adminOrderPlanOptions(db: Db): Promise<AdminOrderPlanOption[]> {
  const plans = await db.plan.findMany({
    where: { archived: false, type: { not: PlanType.TRIAL }, product: { status: { in: [PublishStatus.PUBLISHED, PublishStatus.HIDDEN] } } },
    orderBy: [{ product: { name: "asc" } }, { sortOrder: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      name: true,
      type: true,
      productId: true,
      pricePaise: true,
      perUnit: true,
      maxQty: true,
      product: { select: { name: true, status: true } },
    },
  });
  return plans.map((p) => ({
    id: p.id,
    productId: p.productId,
    productName: p.product.name,
    planName: p.name,
    type: p.type,
    pricePaise: p.pricePaise,
    perUnit: p.perUnit,
    maxQty: p.maxQty,
    productPublished: p.product.status === PublishStatus.PUBLISHED,
  }));
}
