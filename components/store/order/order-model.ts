/**
 * Order page view model (Order.dc.html): hero per order status, actions, polling rules, license card labels and the
 * invoice model input. Pure and client-safe; the page passes plain JSON props (OrderPageData) to the client view.
 */
import type { IconName } from "@/components/icons/icon";
import type { Tone } from "@/lib/design/tokens";
import { formatDateIST, formatMonthYearIST } from "@/lib/dates";
import type { DownloadReleaseView } from "@/lib/downloads/model";
import type { InvoiceModelInput, InvoiceSeller } from "@/lib/invoice/model";
import type { OrderStatusDto, OrderStatusLicense } from "@/lib/orders/status";
import { ORDER_TOKEN_HEADER } from "@/lib/orders/token-header";

export type OrderStatusName = OrderStatusDto["status"];

/** Poll every 2 s while the payment settles, for up to 2 minutes (docs/decisions.md Phase 3). */
export const POLL_INTERVAL_MS = 2_000;
export const POLL_WINDOW_MS = 120_000;
/** A key delivered once stays on screen for 60 s (or until hidden). */
export const KEY_VISIBLE_MS = 60_000;

/** DOM id of a license card's key text. Focus lands there when the key is hidden and its Hide/Copy buttons go away. */
export function licenseKeyDomId(licenseId: string): string {
  return `license-key-${licenseId}`;
}

/** DOM id of a license card's key strip (label, key and buttons). */
export function licenseKeyStripDomId(licenseId: string): string {
  return `license-key-strip-${licenseId}`;
}

/** Ids of the keys whose on-screen time is over at `now`. */
export function expiredKeyIds(keys: Readonly<Record<string, { until: number }>>, now: number): string[] {
  return Object.entries(keys)
    .filter(([, shown]) => shown.until <= now)
    .map(([id]) => id);
}

/** `keys` without `ids` (the same object when none of them is shown, so React skips the render). */
export function withoutKeyIds<T>(keys: Readonly<Record<string, T>>, ids: readonly string[]): Record<string, T> {
  if (!ids.some((id) => id in keys)) return keys;
  return Object.fromEntries(Object.entries(keys).filter(([id]) => !ids.includes(id)));
}

/**
 * Which hidden key takes keyboard focus: the one whose strip holds focus (`focusedIn` tells, per license id). Hiding a
 * key removes its Hide and Copy key buttons; without this, focus would drop to <body>.
 */
export function keyToRefocus(hiddenIds: readonly string[], focusedIn: (licenseId: string) => boolean): string | null {
  return hiddenIds.find((id) => focusedIn(id)) ?? null;
}

const POLLING: ReadonlySet<OrderStatusName> = new Set<OrderStatusName>(["CONFIRMING", "PENDING"]);
const PAID_LIKE: ReadonlySet<OrderStatusName> = new Set<OrderStatusName>(["PAID", "PARTIALLY_REFUNDED"]);
const WITH_INVOICE: ReadonlySet<OrderStatusName> = new Set<OrderStatusName>(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

/** The order is still settling: keep polling. */
export function isPollingStatus(status: OrderStatusName): boolean {
  return POLLING.has(status);
}

/**
 * AWAITING_PAYMENT, FAILED and CANCELED are also polled briefly after the page opens: a failure webhook can land a
 * second after the provider page returns, and a verified return can still reopen a FAILED or CANCELED order as
 * CONFIRMING (docs/decisions.md Phase 3 build decisions). Silent (no "Still confirming" timeout); an order that stays
 * unpaid, failed or canceled stops polling after this window.
 */
export const SETTLE_WINDOW_MS = 15_000;

const SETTLING: ReadonlySet<OrderStatusName> = new Set(["AWAITING_PAYMENT", "FAILED", "CANCELED"]);

export type PollDecision = "poll" | "stop" | "timeout";

/** Whether to poll again, given the status and the time since the polling window started. */
export function pollDecision(status: OrderStatusName, elapsedMs: number): PollDecision {
  if (isPollingStatus(status)) return elapsedMs >= POLL_WINDOW_MS ? "timeout" : "poll";
  return SETTLING.has(status) && elapsedMs < SETTLE_WINDOW_MS ? "poll" : "stop";
}

/** Paid and not (fully) refunded: licenses, next steps and the account prompt show. */
export function isPaidStatus(status: OrderStatusName): boolean {
  return PAID_LIKE.has(status);
}

export function hasInvoice(dto: Pick<OrderStatusDto, "status" | "invoice">): boolean {
  return WITH_INVOICE.has(dto.status) && dto.invoice !== null;
}

export type OrderProductMeta = {
  shortName: string;
  icon: IconName;
  tone: Tone;
  /** Newest published release, for the download row. */
  release: { version: string; sizeLabel: string } | null;
};

export type OrderViewer = {
  /** The order belongs to the viewer's account (or the viewer placed it): "Manage it from your account". */
  member: boolean;
  signedIn: boolean;
  canDownload: boolean;
  canReveal: boolean;
  /** May pay, retry or cancel (order link holder, placer, or a member with `purchases`). */
  canAct: boolean;
};

/** Server -> client props of the order page. Plain JSON. */
export type OrderPageData = {
  orderId: string;
  /** The order link token from `?t=` (guests), or null. */
  token: string | null;
  initial: OrderStatusDto;
  products: Record<string, OrderProductMeta>;
  /** "productId|planName" -> plan.perUnit ("terminal") for the license limit label. */
  planUnits: Record<string, string | null>;
  seller: InvoiceSeller;
  sac: string;
  fallbackGstRatePct: number;
  viewer: OrderViewer;
  /** Dev-only "simulate the bank" controls (NODE_ENV !== production and PAYMENT_PROVIDER = mock). */
  devBankControls: boolean;
  /** Whole minutes a download link lasts: min(setting, DOWNLOAD_LINK_TTL_SECONDS, 600 s), rounded down. */
  downloadLinkMinutes: number;
  /** productId -> published releases with installers, newest first (the download row picks the eligible one). */
  releases: Record<string, DownloadReleaseView[]>;
};

export type HeroTone = "blue" | "sage" | "peach" | "pink" | "slate";

export type HeroView = {
  tone: HeroTone;
  icon: IconName;
  spinning: boolean;
  title: string;
  body: string;
  checklist: boolean;
};

/** Literal class names per tone (Tailwind reads them from source). */
export const HERO_TONE_CLASSES: Readonly<Record<HeroTone, { card: string; fg: string; spinner: string }>> = {
  blue: { card: "bg-blue-bg border-blue-line", fg: "text-blue-fg", spinner: "border-blue-line border-t-blue-fg" },
  sage: { card: "bg-sage-bg border-sage-line", fg: "text-sage-fg", spinner: "border-sage-line border-t-sage-fg" },
  peach: { card: "bg-peach-bg border-peach-line", fg: "text-peach-fg", spinner: "border-peach-line border-t-peach-fg" },
  pink: { card: "bg-pink-bg border-pink-line", fg: "text-pink-fg", spinner: "border-pink-line border-t-pink-fg" },
  slate: { card: "bg-slate-bg border-line-strong", fg: "text-slate-fg", spinner: "border-line-strong border-t-slate-fg" },
};

const DEFAULT_FAIL_REASON = "The payment didn’t go through.";

/** Who prepared or cancelled the order (Admin > Orders); absent in older payloads means "the customer". */
type StaffFlags = Partial<Pick<OrderStatusDto, "placedByStaff" | "canceledByStaff">>;

/** Orders our team prepared or cancelled (admin records, docs/admin-records-design.md B9.2). New copy. */
export const STAFF_ORDER_HERO = {
  ready: {
    tone: "blue",
    icon: "receipt_long",
    spinning: false,
    title: "Ready for payment",
    body: "Our team prepared this order for you. Check the items and billing details, then pay securely. We issue your licenses as soon as the payment is confirmed.",
    checklist: false,
  },
  canceled: {
    tone: "slate",
    icon: "cancel",
    spinning: false,
    title: "Order cancelled",
    body: "Our team cancelled this order, so it can’t be paid. Contact us if you still want to buy.",
    checklist: false,
  },
  closed: {
    tone: "slate",
    icon: "cancel",
    spinning: false,
    title: "Payment canceled",
    body: "You closed the payment page before paying. Nothing was charged. You can pay whenever you’re ready.",
    checklist: false,
  },
} as const satisfies Record<string, HeroView>;

/**
 * Hero copy per status (Order.dc.html, verbatim unless noted):
 * - PAID: says the order confirmation was emailed, not the key (emails never carry keys, decisions.md Phase 3).
 * - CONFIRMING after the 2-minute polling window: "Still confirming" (decisions.md Phase 3; new copy).
 * - REFUNDED / PARTIALLY_REFUNDED: not designed; new copy from the refund policy.
 */
export function heroFor(
  dto: Pick<OrderStatusDto, "status" | "email" | "failReason" | "licenses"> & StaffFlags,
  opts: { timedOut?: boolean } = {},
): HeroView {
  if (dto.canceledByStaff) return STAFF_ORDER_HERO.canceled;
  if (dto.placedByStaff && dto.status === "AWAITING_PAYMENT") return STAFF_ORDER_HERO.ready;
  if (dto.placedByStaff && dto.status === "CANCELED") return STAFF_ORDER_HERO.closed;
  switch (dto.status) {
    case "CONFIRMING":
      return opts.timedOut
        ? {
            tone: "blue",
            icon: "hourglass_top",
            spinning: false,
            title: "Still confirming your payment",
            body: "This is taking longer than usual. You don’t need to pay again: we’ll email you as soon as the provider confirms it. Refresh the status to check again.",
            checklist: true,
          }
        : {
            tone: "blue",
            icon: "hourglass_top",
            spinning: true,
            title: "Confirming your payment…",
            body: "The payment provider has your payment. We issue licenses only after our server verifies it, which usually takes a few seconds. You can keep this page open.",
            checklist: true,
          };
    case "PAID":
      return dto.licenses.length > 0
        ? {
            tone: "sage",
            icon: "check_circle",
            spinning: false,
            title: "Payment confirmed — your software is ready",
            body: `We’ve emailed your order confirmation to ${dto.email}. Download the installer and activate it with the key below.`,
            checklist: false,
          }
        : {
            tone: "sage",
            icon: "check_circle",
            spinning: false,
            title: "Payment confirmed",
            body: `We’ve emailed your order confirmation to ${dto.email}. Your licenses are updated, and your tax invoice is below.`,
            checklist: false,
          };
    case "PENDING":
      return {
        tone: "peach",
        icon: "schedule",
        spinning: false,
        title: "Payment pending with your bank",
        body: "Your bank hasn’t confirmed this payment yet. You don’t need to pay again. We’ll email you and issue your license automatically once it’s confirmed — usually within 30 minutes.",
        checklist: false,
      };
    case "FAILED":
      return {
        tone: "pink",
        icon: "error",
        spinning: false,
        title: "Payment failed",
        body: `${dto.failReason?.trim() || DEFAULT_FAIL_REASON} No license was issued. If money left your account, your bank will reverse it automatically. Your cart is saved.`,
        checklist: false,
      };
    case "CANCELED":
      return {
        tone: "slate",
        icon: "cancel",
        spinning: false,
        title: "Payment canceled",
        body: "You closed the payment page before paying. Nothing was charged and your cart is saved.",
        checklist: false,
      };
    case "REVIEW":
      return {
        tone: "peach",
        icon: "policy",
        spinning: false,
        title: "We’re reviewing this payment",
        body: "The amount received didn’t match the order, so our team is checking it. We’ll contact you shortly.",
        checklist: false,
      };
    case "REFUNDED":
      return {
        tone: "slate",
        icon: "currency_exchange",
        spinning: false,
        title: "Order refunded",
        body: "We’ve refunded this order to your original payment method; it usually arrives within 5–7 working days. Licenses from this order no longer work.",
        checklist: false,
      };
    case "PARTIALLY_REFUNDED":
      return {
        tone: "slate",
        icon: "currency_exchange",
        spinning: false,
        title: "Order partly refunded",
        body: "Part of this order was refunded to your original payment method; it usually arrives within 5–7 working days. Licenses that weren’t refunded keep working.",
        checklist: false,
      };
    default:
      return {
        tone: "slate",
        icon: "payments",
        spinning: false,
        title: "Waiting for payment",
        body: "This order hasn’t been paid yet.",
        checklist: false,
      };
  }
}

export type HeroAction =
  | { id: "retry"; label: string; primary: true }
  | { id: "refresh"; label: string; primary: false }
  | { id: "invoice" | "checkout" | "cart" | "support"; label: string; primary: boolean; href: string };

/**
 * Hero buttons per status (Order.dc.html `actions`), plus "Refresh status" once polling has timed out. Orders our team
 * prepared pay through "Pay now" and offer "Contact support" instead of the cart (the cart never held them); orders our
 * team cancelled offer only "Contact support".
 */
export function heroActions(
  dto: Pick<OrderStatusDto, "status" | "canRetry" | "invoice"> & StaffFlags,
  links: { invoicePdf: string },
  opts: { timedOut?: boolean } = {},
): HeroAction[] {
  const refresh: HeroAction[] = opts.timedOut ? [{ id: "refresh", label: "Refresh status", primary: false }] : [];
  const support: HeroAction = { id: "support", label: "Contact support", primary: false, href: "/support" };
  if (dto.canceledByStaff) return [support];
  if (dto.placedByStaff && (dto.status === "AWAITING_PAYMENT" || dto.status === "CANCELED" || dto.status === "FAILED")) {
    const label = dto.status === "FAILED" ? "Try again" : "Pay now";
    return [...(dto.canRetry ? [{ id: "retry", label, primary: true } as const] : []), support];
  }
  switch (dto.status) {
    case "PAID":
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return hasInvoice(dto) ? [{ id: "invoice", label: "Download invoice", primary: false, href: links.invoicePdf }] : [];
    case "FAILED":
      return [
        ...(dto.canRetry ? [{ id: "retry", label: "Try again", primary: true } as const] : []),
        { id: "checkout", label: "Back to checkout", primary: false, href: "/checkout" },
      ];
    case "CANCELED":
    case "AWAITING_PAYMENT":
      return [
        ...(dto.canRetry ? [{ id: "retry", label: "Return to payment", primary: true } as const] : []),
        { id: "cart", label: "Edit order", primary: false, href: "/cart" },
      ];
    case "PENDING":
      return [{ id: "support", label: "Contact support", primary: false, href: "/support" }, ...refresh];
    case "CONFIRMING":
      return refresh;
    default:
      return [];
  }
}

/**
 * Same-origin API and page paths for an order. The link token (guests) rides in the X-Order-Token header on the status
 * polls (statusHeaders: request lines can reach the Nginx error log) and in `?t=` only on the invoice PDF link, a
 * plain download (owner decision S2). The POST actions send it in the body.
 */
export function orderPaths(orderId: string, token: string | null) {
  const id = encodeURIComponent(orderId);
  const t = token ? `?t=${encodeURIComponent(token)}` : "";
  const statusHeaders: Record<string, string> = token ? { [ORDER_TOKEN_HEADER]: token } : {};
  return {
    status: `/api/orders/${id}/status`,
    statusHeaders,
    invoicePdf: `/api/orders/${id}/invoice.pdf${t}`,
    /** A billing correction's credit note (InvoiceCorrection id), carrying `?t=` like the invoice PDF. */
    creditNotePdf: (noteId: string) => `/api/orders/${id}/credit-notes/${encodeURIComponent(noteId)}${t}`,
    retry: `/api/checkout/orders/${id}/retry`,
    returnUrl: `/api/checkout/orders/${id}/return`,
    cancel: `/api/checkout/orders/${id}/cancel`,
    downloads: `/api/orders/${id}/downloads`,
    page: `/orders/${id}`,
  };
}

/** "1 computer", "3 terminals" (prototype: deviceLimit + perUnit). */
export function licenseLimitLabel(deviceLimit: number, perUnit: string | null | undefined): string {
  const unit = perUnit ? perUnit : "computer";
  return `${deviceLimit} ${unit}${deviceLimit === 1 ? "" : "s"}`;
}

/** "valid until 7 Oct 2027" or "no expiry · updates until Oct 2027" (IST). */
export function licenseTermLabel(license: Pick<OrderStatusLicense, "expiresAt" | "updatesUntil">): string {
  return license.expiresAt
    ? `valid until ${formatDateIST(new Date(license.expiresAt))}`
    : `no expiry · updates until ${formatMonthYearIST(new Date(license.updatesUntil))}`;
}

export function planUnitKey(productId: string, planName: string): string {
  return `${productId}|${planName}`;
}

/** The shared invoice model input for the current status response. */
export function invoiceInputFrom(dto: OrderStatusDto, data: Pick<OrderPageData, "products" | "seller" | "sac" | "fallbackGstRatePct">): InvoiceModelInput {
  return {
    orderId: dto.id,
    status: dto.status,
    createdAt: dto.createdAt,
    invoice: dto.invoice,
    sac: data.sac,
    seller: data.seller,
    billing: dto.billing,
    placeOfSupply: dto.placeOfSupply,
    couponCode: dto.couponCode,
    totals: dto.totals,
    items: dto.items.map((item) => ({
      productName: item.productName,
      productShortName: data.products[item.productId]?.shortName ?? null,
      planName: item.planName,
      kind: item.kind,
      qty: item.qty,
      unitPricePaise: item.unitPricePaise,
      discountPaise: item.discountPaise,
      taxablePaise: item.taxablePaise,
      taxPaise: item.taxPaise,
      targetLicenseId: item.targetLicenseId,
    })),
    fallbackGstRatePct: data.fallbackGstRatePct,
    document: { kind: "invoice", replaces: dto.invoice?.replaces ?? null },
  };
}

/** "Credit note AXC/26-27/0004 · cancels invoice AXS/26-27/0012 · 8 Oct 2026" (order page, under the invoice). */
export function creditNoteLabel(note: { number: string; cancelsInvoice: string; issuedAt: string }): string {
  return `Credit note ${note.number} · cancels invoice ${note.cancelsInvoice} · ${formatDateIST(new Date(note.issuedAt))}`;
}
