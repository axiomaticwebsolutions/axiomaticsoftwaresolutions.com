"use client";

import * as React from "react";
import { clearCartForPaidOrder } from "@/components/checkout/cart-order";
import { startHostedCheckout } from "@/components/checkout/hosted-checkout";
import { toast } from "@/components/ui/sonner";
import type { CheckoutStart } from "@/lib/checkout/payment-attempt";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { buildInvoiceModel } from "@/lib/invoice/model";
import type { OrderStatusDto, OrderStatusLicense } from "@/lib/orders/status";
import { InvoiceSummary } from "./invoice-summary";
import { LicenseCard } from "./license-card";
import { OrderHero } from "./order-hero";
import {
  expiredKeyIds,
  heroActions,
  heroFor,
  invoiceInputFrom,
  isPaidStatus,
  KEY_VISIBLE_MS,
  keyToRefocus,
  licenseKeyDomId,
  licenseKeyStripDomId,
  orderPaths,
  planUnitKey,
  POLL_INTERVAL_MS,
  pollDecision,
  type HeroAction,
  type OrderPageData,
  type OrderStatusName,
  withoutKeyIds,
} from "./order-model";
import { OrderNextSteps } from "./order-next-steps";

type ShownKey = { key: string; until: number };

const BANK_PATH = "/api/dev/mock-checkout/bank";

/** Keeps full keys out of the status state: they live only in `keys` while on screen. */
function withoutKeys(dto: OrderStatusDto): OrderStatusDto {
  return {
    ...dto,
    licenses: dto.licenses.map((license): OrderStatusLicense => {
      const { key, ...rest } = license;
      void key;
      return rest;
    }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

/**
 * The order page (Order.dc.html) on the client: polls GET /api/orders/:id/status every 2 s for up to 2 minutes while
 * the payment settles, shows each key the API delivers once (60 s, or until hidden), runs "Try again" / "Return to
 * payment" through the retry endpoint, and clears the cart when the order the cart produced is paid.
 */
export function OrderView({ data }: { data: OrderPageData }) {
  const paths = React.useMemo(() => orderPaths(data.orderId, data.token), [data.orderId, data.token]);
  const [dto, setDto] = React.useState<OrderStatusDto>(() => withoutKeys(data.initial));
  const [timedOut, setTimedOut] = React.useState(false);
  const [busy, setBusy] = React.useState<HeroAction["id"] | null>(null);
  const [bankBusy, setBankBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keys, setKeys] = React.useState<Record<string, ShownKey>>({});
  const [now, setNow] = React.useState(() => Date.now());
  const [copied, setCopied] = React.useState<string | null>(null);

  const statusRef = React.useRef<OrderStatusName>(dto.status);
  const timer = React.useRef<number | undefined>(undefined);
  const inflight = React.useRef(false);
  const mounted = React.useRef(false);
  const windowStart = React.useRef(Date.now());
  const poll = React.useRef<() => Promise<void>>(async () => undefined);
  /** License whose key strip held focus when its key was hidden: focus moves to its (now masked) key text. */
  const refocusKey = React.useRef<string | null>(null);

  const schedule = React.useCallback((status: OrderStatusName, delay: number = POLL_INTERVAL_MS) => {
    window.clearTimeout(timer.current);
    if (!mounted.current) return;
    const decision = pollDecision(status, Date.now() - windowStart.current);
    if (decision === "timeout") setTimedOut(true);
    if (decision !== "poll") return;
    timer.current = window.setTimeout(() => void poll.current(), delay);
  }, []);

  // Never aborted: a response may carry a key that is delivered only once, so it is always applied.
  const load = React.useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    let next: OrderStatusName | null = statusRef.current;
    let delay = POLL_INTERVAL_MS;
    try {
      const res = await apiFetch<OrderStatusDto>(paths.status, { headers: paths.statusHeaders });
      const delivered = res.licenses.filter((l): l is OrderStatusLicense & { key: string } => typeof l.key === "string");
      if (delivered.length > 0) {
        const until = Date.now() + KEY_VISIBLE_MS;
        setNow(Date.now());
        setKeys((prev) => ({ ...prev, ...Object.fromEntries(delivered.map((l) => [l.id, { key: l.key, until }])) }));
      }
      statusRef.current = res.status;
      next = res.status;
      setDto(withoutKeys(res));
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        setError(e.message);
        next = null;
      } else if (e instanceof ApiClientError && e.status === 429) {
        const retryAfter = Number(e.details.retryAfterSec);
        delay = Math.max(POLL_INTERVAL_MS, (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000);
      }
    } finally {
      inflight.current = false;
    }
    if (next) schedule(next, delay);
  }, [paths.status, paths.statusHeaders, schedule]);

  React.useEffect(() => {
    poll.current = load;
  }, [load]);

  React.useEffect(() => {
    mounted.current = true;
    void poll.current(); // the first response delivers any key not yet shown
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  React.useEffect(() => {
    // Removes the cart lines this browser ordered (checkout recorded them with rememberCartOrder).
    if (isPaidStatus(dto.status)) clearCartForPaidOrder(dto.id);
  }, [dto.status, dto.id]);

  React.useEffect(() => {
    if (Object.keys(keys).length === 0) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const expired = expiredKeyIds(keys, t);
      if (expired.length === 0) return;
      // A keyboard user on "Copy key" when the 60 s run out keeps their place in the licenses list.
      const focused = document.activeElement;
      refocusKey.current ??= keyToRefocus(expired, (licenseId) =>
        Boolean(focused && document.getElementById(licenseKeyStripDomId(licenseId))?.contains(focused)),
      );
      setKeys((prev) => withoutKeyIds(prev, expired));
    }, 1000);
    return () => window.clearInterval(id);
  }, [keys]);

  // After a hidden key's buttons unmount: focus its masked key text instead of letting it fall to <body>.
  React.useEffect(() => {
    const licenseId = refocusKey.current;
    if (!licenseId || keys[licenseId]) return;
    refocusKey.current = null;
    document.getElementById(licenseKeyDomId(licenseId))?.focus();
  }, [keys]);

  const restartPolling = React.useCallback(async () => {
    windowStart.current = Date.now();
    setTimedOut(false);
    await poll.current();
  }, []);

  const tokenBody = data.token ? { t: data.token } : {};

  async function retry() {
    setBusy("retry");
    setError(null);
    try {
      const start = await apiFetch<CheckoutStart>(paths.retry, { body: tokenBody });
      // Mock: the dev checkout page. Razorpay: the modal; its return or cancel then reloads this page (statusUrl).
      await startHostedCheckout(start);
    } catch (e) {
      setBusy(null);
      if (e instanceof ApiClientError && e.status === 409 && e.code === "not_retryable") {
        // A payment for this order is already being confirmed: show its progress instead of an error.
        await restartPolling();
        return;
      }
      setError(messageOf(e));
      void poll.current();
    }
  }

  async function refresh() {
    setBusy("refresh");
    setError(null);
    await restartPolling();
    setBusy(null);
  }

  function onAction(id: "retry" | "refresh") {
    if (busy) return;
    void (id === "retry" ? retry() : refresh());
  }

  async function answerBank(ok: boolean) {
    setBankBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ status: OrderStatusName }>(BANK_PATH, { body: { orderId: data.orderId, ok, ...tokenBody } });
      statusRef.current = res.status;
      setDto((d) => ({ ...d, status: res.status }));
      windowStart.current = Date.now();
      setTimedOut(false);
      schedule(res.status);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBankBusy(false);
    }
  }

  function hideKey(id: string) {
    if (keys[id]) refocusKey.current = id; // "Hide" had focus and unmounts with the key
    setKeys((prev) => withoutKeyIds(prev, [id]));
  }

  function copyKey(id: string) {
    const shown = keys[id];
    if (!shown) return;
    const fail = () => toast.error("We couldn’t copy the key. Select it and copy it instead.");
    if (!navigator.clipboard) return fail();
    navigator.clipboard.writeText(shown.key).then(() => {
      setCopied(id);
      toast("License key copied to clipboard");
    }, fail);
  }

  const hero = heroFor(dto, { timedOut });
  const actions = heroActions(dto, { invoicePdf: paths.invoicePdf }, { timedOut });
  const invoice = React.useMemo(
    () => buildInvoiceModel(invoiceInputFrom(dto, data)),
    [dto, data],
  );
  const paid = isPaidStatus(dto.status);
  const showBank = data.devBankControls && data.viewer.canAct && dto.status === "PENDING" && dto.provider === "mock";

  return (
    <div className="mx-auto max-w-[960px] px-6 pt-8 pb-24 leading-[normal] print:max-w-none print:p-0">
      <OrderHero
        orderId={dto.id}
        hero={hero}
        actions={actions}
        busy={busy}
        onAction={onAction}
        error={error}
        bank={showBank ? { busy: bankBusy, onAnswer: (ok) => void answerBank(ok) } : null}
      />
      {paid && dto.licenses.length > 0 ? (
        <section aria-labelledby="lic-h" className="mt-6">
          <h2 id="lic-h" className="text-[22px] font-extrabold">
            Your licenses
          </h2>
          <div className="mt-3.5 grid gap-3.5">
            {dto.licenses.map((license) => {
              const shown = keys[license.id];
              return (
                <LicenseCard
                  key={license.id}
                  license={license}
                  product={data.products[license.productId]}
                  perUnit={data.planUnits[planUnitKey(license.productId, license.planName)] ?? null}
                  revealed={shown ? { key: shown.key, secondsLeft: Math.max(1, Math.ceil((shown.until - now) / 1000)) } : null}
                  copied={copied === license.id}
                  onCopy={() => copyKey(license.id)}
                  onHide={() => hideKey(license.id)}
                  viewer={data.viewer}
                  canClaim={dto.canClaim}
                  downloadLinkMinutes={data.downloadLinkMinutes}
                  releases={data.releases[license.productId] ?? []}
                  orderId={dto.id}
                  token={data.token}
                />
              );
            })}
          </div>
        </section>
      ) : null}
      {paid ? <OrderNextSteps orderId={dto.id} email={dto.email} viewer={data.viewer} canClaim={dto.canClaim} /> : null}
      <InvoiceSummary model={invoice} pdfHref={paths.invoicePdf} />
    </div>
  );
}
