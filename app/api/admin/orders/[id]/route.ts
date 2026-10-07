/** GET /api/admin/orders/:id (orders.view): the order drawer (lib/admin/orders/detail.ts). */
import { adminRoute, idParam } from "@/lib/admin/http";
import { getAdminOrderDetail } from "@/lib/admin/orders/detail";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string }>("orders.view", async ({ params }) =>
  json({ order: await getAdminOrderDetail(db, idParam(params, "id", "Order")) }),
);
