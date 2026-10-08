/**
 * GET /api/orders/:id/status: the order page's view of an order (polled every 2 s while it confirms).
 *
 * One-time key delivery (decisions.md 10): while License.keyDeliveredAt is null, the response for the purchaser
 * (OrderAccess.isPurchaser) carries the full key of each active license the order issued. Claiming the delivery and
 * recording a `key_delivered` LicenseEvent happen in one transaction with a conditional update
 * (keyDeliveredAt IS NULL), so concurrent polls deliver each key at most once; every later response is masked.
 * Keys are decrypted in memory only, never logged or persisted elsewhere; responses are Cache-Control: no-store.
 */
import { LicenseStatus, OrderStatus, type ItemKind } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { getLicenseKeySecrets } from "@/lib/env";
import { decryptLicenseKey, type LicenseKeySecrets } from "@/lib/licensing/crypto";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { deriveLicenseStatus, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { log } from "@/lib/log";
import { readBillingSnapshot, type BillingSnapshot } from "./billing";
import type { OrderAccess } from "./access";

export type OrderStatusItem = {
  planName: string;
  productName: string;
  productId: string;
  kind: ItemKind;
  qty: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
};

export type OrderStatusLicense = {
  id: string;
  productId: string;
  productName: string;
  planName: string;
  keyMasked: string;
  /** The full key, only in the one response that delivers it to the purchaser. */
  key?: string;
  /** Derived status: active | expiring | expired | trial | suspended | revoked. */
  status: DerivedLicenseStatus;
  expiresAt: string | null;
  updatesUntil: string;
  deviceLimit: number;
};

/** A credit note of a billing correction (Admin > Orders "Correct billing"), downloadable from the order page. */
export type OrderStatusCreditNote = { id: string; number: string; issuedAt: string; cancelsInvoice: string };

export type OrderStatusDto = {
  id: string;
  status: OrderStatus;
  failReason: string | null;
  createdAt: string;
  paidAt: string | null;
  email: string;
  billing: BillingSnapshot;
  placeOfSupply: string;
  couponCode: string | null;
  totals: {
    subtotalPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
  };
  items: OrderStatusItem[];
  /** The current tax invoice; `replaces` names the invoice a billing correction cancelled. */
  invoice: { number: string; issuedAt: string; replaces: { invoiceNo: string; creditNoteNo: string } | null } | null;
  /** Credit notes of billing corrections, oldest first. */
  creditNotes: OrderStatusCreditNote[];
  /** Our team prepared this order (Admin > Orders): the page reads "Ready for payment", without "Edit order". */
  placedByStaff: boolean;
  /** Our team cancelled it: it can't be paid. */
  canceledByStaff: boolean;
  /** An unpaid order staff created whose terms the customer must accept before "Pay now". */
  termsRequired: boolean;
  licenses: OrderStatusLicense[];
  /** "Try again" / "Return to payment" is available to this viewer. */
  canRetry: boolean;
  /** Guest order whose email has no verified user yet: show "Create account". */
  canClaim: boolean;
  /** Provider of the latest payment attempt ("mock", "razorpay"), or null. */
  provider: string | null;
};

const RETRY_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.FAILED,
  OrderStatus.CANCELED,
  OrderStatus.AWAITING_PAYMENT,
]);
/** Orders whose issued licenses may be delivered (refunded orders revoke theirs). */
const DELIVERY_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED]);
const DELIVERABLE_LICENSE: ReadonlySet<LicenseStatus> = new Set<LicenseStatus>([LicenseStatus.ACTIVE, LicenseStatus.TRIAL]);

export type BuildOrderStatusOptions = {
  now?: Date;
  /** False disables key delivery for this response (e.g. a cross-site request). Default true. */
  allowKeyDelivery?: boolean;
  secrets?: LicenseKeySecrets;
};

/** Builds the status DTO, delivering keys once to the purchaser (see the module comment). */
export async function buildOrderStatus(
  db: PrismaClient,
  access: OrderAccess,
  opts: BuildOrderStatusOptions = {},
): Promise<OrderStatusDto> {
  const now = opts.now ?? new Date();
  const orderId = access.order.id;
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: {
        orderBy: { id: "asc" },
        include: { plan: { select: { name: true, productId: true, product: { select: { name: true } } } } },
      },
      invoice: { select: { number: true, issuedAt: true } },
      payments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { provider: true } },
      invoiceCorrections: {
        orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
        select: { id: true, creditNoteNo: true, originalInvoiceNo: true, newInvoiceNo: true, issuedAt: true },
      },
    },
  });
  const licenses = await db.license.findMany({
    where: { orderId },
    orderBy: { id: "asc" },
    include: { product: { select: { name: true, code: true } }, plan: { select: { name: true } } },
  });

  const delivered = new Map<string, string>();
  const canDeliver = (opts.allowKeyDelivery ?? true) && access.isPurchaser && DELIVERY_STATUSES.has(order.status);
  const pending = canDeliver ? licenses.filter((l) => l.keyDeliveredAt === null && DELIVERABLE_LICENSE.has(l.status)) : [];
  if (pending.length > 0) {
    const secrets = opts.secrets ?? getLicenseKeySecrets();
    const decrypted: Array<{ id: string; key: string }> = [];
    for (const license of pending) {
      try {
        decrypted.push({ id: license.id, key: decryptLicenseKey(license.keyCiphertext, secrets.encKey) });
      } catch (error) {
        // Never deliver a key we could not read back; the portal reveal stays available.
        log.error("order_key_decrypt_failed", { orderId, licenseId: license.id, error });
      }
    }
    const actor = access.viewer.name ?? "Order link";
    await db.$transaction(async (tx) => {
      for (const { id, key } of decrypted) {
        const claimed = await tx.license.updateMany({ where: { id, keyDeliveredAt: null }, data: { keyDeliveredAt: now } });
        if (claimed.count !== 1) continue; // another response delivered it first
        await tx.licenseEvent.create({ data: { licenseId: id, type: "key_delivered", actor, detail: `Order ${orderId}`, createdAt: now } });
        delivered.set(id, key);
      }
    });
    if (delivered.size > 0) log.info("order_keys_delivered", { orderId, licenses: delivered.size, byOrderLink: access.viaToken });
  }

  const replaced = order.invoice ? order.invoiceCorrections.find((c) => c.newInvoiceNo === order.invoice?.number) : undefined;
  const unpaid = RETRY_STATUSES.has(order.status);
  const canClaim =
    order.accountId === null &&
    (await db.user.count({ where: { email: order.email, emailVerifiedAt: { not: null } } })) === 0;

  return {
    id: order.id,
    status: order.status,
    failReason: order.failReason,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    email: order.email,
    billing: readBillingSnapshot(order.billing),
    placeOfSupply: order.placeOfSupply,
    couponCode: order.couponCode,
    totals: {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      taxablePaise: order.taxablePaise,
      cgstPaise: order.cgstPaise,
      sgstPaise: order.sgstPaise,
      igstPaise: order.igstPaise,
      totalPaise: order.totalPaise,
    },
    items: order.items.map((item) => ({
      planName: item.plan.name,
      productName: item.plan.product.name,
      productId: item.plan.productId,
      kind: item.kind,
      qty: item.quantity,
      unitPricePaise: item.unitPricePaise,
      discountPaise: item.discountPaise,
      taxablePaise: item.taxablePaise,
      taxPaise: item.taxPaise,
      targetLicenseId: item.targetLicenseId,
    })),
    invoice: order.invoice
      ? {
          number: order.invoice.number,
          issuedAt: order.invoice.issuedAt.toISOString(),
          replaces: replaced ? { invoiceNo: replaced.originalInvoiceNo, creditNoteNo: replaced.creditNoteNo } : null,
        }
      : null,
    creditNotes: order.invoiceCorrections.map((c) => ({
      id: c.id,
      number: c.creditNoteNo,
      issuedAt: c.issuedAt.toISOString(),
      cancelsInvoice: c.originalInvoiceNo,
    })),
    placedByStaff: order.createdByStaffId !== null,
    canceledByStaff: order.canceledByStaffAt !== null,
    termsRequired: order.createdByStaffId !== null && order.termsAcceptedAt === null && unpaid && order.canceledByStaffAt === null,
    licenses: licenses.map((license) => {
      const key = delivered.get(license.id);
      return {
        id: license.id,
        productId: license.productId,
        productName: license.product.name,
        planName: license.plan.name,
        keyMasked: maskLicenseKey(license.product.code, license.keyLast4),
        ...(key !== undefined ? { key } : {}),
        status: deriveLicenseStatus(license, now),
        expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
        updatesUntil: license.updatesUntil.toISOString(),
        deviceLimit: license.deviceLimit,
      };
    }),
    canRetry: access.canAct && unpaid && order.canceledByStaffAt === null,
    canClaim,
    provider: order.payments[0]?.provider ?? null,
  };
}
