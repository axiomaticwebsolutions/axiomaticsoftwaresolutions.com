/**
 * Fixtures for the Coupons / Content / Templates / Leads admin DB tests (not a test file). Ids and codes carry a random
 * tag because DB test files share one schema per run.
 */
import { randomBytes } from "node:crypto";
import type { StaffRole, User } from "@/generated/prisma/client";
import { actorFromStaff, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import { makeStaff } from "../support/admin-fixtures";
import { freshProductCode } from "../support/product-codes";

export const tag = () => randomBytes(4).toString("hex");
export const TAG = () => tag().toUpperCase();

export type StaffFixture = { user: User; staff: { id: string; role: StaffRole; email: string }; actor: AuditActor };

export async function staffFixture(role: StaffRole): Promise<StaffFixture> {
  const user = await makeStaff(role);
  return { user, staff: { id: user.id, role, email: user.email }, actor: actorFromStaff(user, "103.21.44.x") };
}

/** A category and a published product (id `m5-<tag>`), for coupon scopes and product FAQ pages. */
export async function makeProduct(): Promise<{ id: string; name: string }> {
  const t = tag();
  const category = await db.category.create({ data: { id: `m5cat-${t}`, name: `M5 category ${t}`, tone: "sage", icon: "key" } });
  const code = await freshProductCode();
  const product = await db.product.create({
    data: {
      id: `m5-${t}`,
      code,
      name: `M5 Product ${t}`,
      shortName: `M5 ${t}`,
      tagline: "Test product",
      summary: "Test product",
      icon: "receipt_long",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      rank: 900,
      content: {},
      relatedIds: [],
    },
  });
  return { id: product.id, name: product.shortName };
}

export const auditRows = (targetType: string, targetId: string) =>
  db.auditLog.findMany({ where: { targetType, targetId }, orderBy: { createdAt: "asc" } });

/** An order that used `couponCode` (minimal fields; never paid). */
export async function makeOrderWithCoupon(couponCode: string): Promise<string> {
  const id = `AX-M5${TAG()}`;
  await db.order.create({
    data: {
      id,
      email: `m5.${tag()}@example.test`,
      billing: {},
      couponCode,
      subtotalPaise: 100_000,
      discountPaise: 10_000,
      taxablePaise: 90_000,
      totalPaise: 106_200,
      placeOfSupply: "Maharashtra",
    },
  });
  return id;
}

/** Rejection of an ApiError-like error: { status, code, details }. */
export async function rejection(promise: Promise<unknown>): Promise<{ status: number; code: string; details?: Record<string, unknown>; message: string }> {
  try {
    await promise;
  } catch (e) {
    const err = e as { status?: number; code?: string; details?: Record<string, unknown>; message: string };
    if (typeof err.status === "number" && typeof err.code === "string") return err as never;
    throw e;
  }
  throw new Error("expected the call to fail");
}
