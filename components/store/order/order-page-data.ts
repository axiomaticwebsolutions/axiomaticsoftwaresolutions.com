/**
 * Server-side data of the order page (server-only): everything the client view needs beyond the status response,
 * i.e. product names, icons and tones, the newest installer per product, plan units, the seller snapshot and SAC
 * of the invoice (current settings until the order is invoiced), what this viewer may do, and the published releases
 * with installers of the licensed products (the download row picks the release each license may download).
 */
import "server-only";
import { toIconName } from "@/components/store/active-nav";
import type { PrismaClient } from "@/generated/prisma/client";
import { downloadTtlSeconds, getSettings } from "@/lib/config";
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";
import { linkMinutes, primaryFile, type DownloadReleaseView } from "@/lib/downloads/model";
import { loadPublishedReleases, toDownloadReleaseView } from "@/lib/downloads/releases";
import { readSellerSnapshot, type InvoiceSeller } from "@/lib/invoice/model";
import type { OrderAccess } from "@/lib/orders/access";
import type { OrderStatusDto } from "@/lib/orders/status";
import { mockCheckoutEnabled } from "@/lib/payments/mock-delivery";
import { teamCan } from "@/lib/rbac";
import { planUnitKey, type OrderPageData, type OrderProductMeta } from "./order-model";

/** Releases per product sent to the order page (newest first; enough for licenses whose updates ended long ago). */
const ORDER_PAGE_RELEASES = 20;

const toTone = (value: string | null | undefined): Tone | null =>
  value && (TONE_NAMES as readonly string[]).includes(value) ? (value as Tone) : null;

export async function loadOrderPageData(
  db: PrismaClient,
  access: OrderAccess,
  dto: OrderStatusDto,
  token: string | null,
): Promise<OrderPageData> {
  const orderId = access.order.id;
  const productIds = [...new Set([...dto.items.map((i) => i.productId), ...dto.licenses.map((l) => l.productId)])];
  const [settings, products, items, invoice, published] = await Promise.all([
    getSettings(db),
    db.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        shortName: true,
        icon: true,
        tone: true,
        category: { select: { tone: true } },
      },
    }),
    db.orderItem.findMany({ where: { orderId }, select: { plan: { select: { productId: true, name: true, perUnit: true } } } }),
    db.invoice.findUnique({ where: { orderId }, select: { sac: true, seller: true } }),
    // Every ordered product, not only licensed ones: licenses appear while the page polls a confirming payment.
    loadPublishedReleases(db, productIds, new Date(), ORDER_PAGE_RELEASES),
  ]);

  const releases: Record<string, DownloadReleaseView[]> = {};
  for (const [productId, list] of published) releases[productId] = list.map(toDownloadReleaseView);

  const productMeta: Record<string, OrderProductMeta> = {};
  for (const p of products) {
    // The newest stable release (highest version), the same one the download row and the portal call "latest".
    const release = published.get(p.id)?.[0];
    productMeta[p.id] = {
      shortName: p.shortName,
      icon: toIconName(p.icon, "receipt_long"),
      tone: toTone(p.tone) ?? toTone(p.category.tone) ?? "lavender",
      release: release ? { version: release.version, sizeLabel: primaryFile(release.files)?.sizeLabel ?? "" } : null,
    };
  }
  const planUnits: Record<string, string | null> = {};
  for (const { plan } of items) planUnits[planUnitKey(plan.productId, plan.name)] = plan.perUnit;

  const business = settings.business;
  const seller: InvoiceSeller = invoice
    ? readSellerSnapshot(invoice.seller)
    : {
        legalName: business.legalName,
        gstin: business.gstin,
        address: business.address,
        city: business.city,
        state: business.state,
        pin: business.pin,
        sample: business.sample,
      };

  // "Manage it from your account" only when the order is in the viewer’s account (a member of order.accountId).
  const { viewer } = access;
  const member = viewer.role !== null;
  return {
    orderId,
    token,
    initial: dto,
    products: productMeta,
    planUnits,
    seller,
    sac: invoice?.sac ?? settings.tax.sac,
    fallbackGstRatePct: settings.tax.gstRatePct,
    viewer: {
      member,
      signedIn: viewer.userId !== null,
      canDownload: teamCan(viewer.role, "downloads"),
      canReveal: teamCan(viewer.role, "keys.reveal"),
      canAct: access.canAct,
    },
    devBankControls: await mockCheckoutEnabled(),
    downloadLinkMinutes: linkMinutes(downloadTtlSeconds(settings)),
    releases,
  };
}
