"use client";

/**
 * Server quote for the client cart (POST /api/checkout/quote), shared by /cart and /checkout.
 *
 * Keyed by the request (items, coupon) plus a `scope` that changes when the viewer does (signing out re-prices as a
 * guest). The first request goes out at once, later ones after a short debounce so a quantity stepper does not send
 * a request per click; superseded requests are aborted. The last result stays visible while a new one loads
 * (`current` is false meanwhile). Results are cached per key for the page's lifetime, so undoing a change or
 * re-applying a coupon does not ask the server again (coupon quotes are rate limited).
 */
import * as React from "react";
import type { QuoteDto } from "@/lib/checkout/quote";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import type { CheckoutRequestItem } from "./cart-model";

export const QUOTE_PATH = "/api/checkout/quote";
export const QUOTE_DEBOUNCE_MS = 300;
const CACHE_SIZE = 12;

export type QuoteRequestBody = { items: CheckoutRequestItem[]; couponCode?: string | null };

export function quoteKey(body: QuoteRequestBody, scope = ""): string {
  return JSON.stringify([scope, body.couponCode ?? null, body.items.map((i) => [i.planId, i.qty, i.kind, i.targetLicenseId])]);
}

/** One quote request (throws ApiClientError; aborts rethrow the AbortError). */
export function fetchQuote(body: QuoteRequestBody, signal?: AbortSignal): Promise<QuoteDto> {
  const payload = body.couponCode ? body : { items: body.items };
  return apiFetch<QuoteDto>(QUOTE_PATH, { method: "POST", body: payload, signal });
}

export type UseQuoteResult = {
  /** The latest quote received (possibly for an earlier request while `current` is false). */
  data: QuoteDto | null;
  /** True when `data` answers the current request. */
  current: boolean;
  /** Error of the current request, if it failed. */
  error: ApiClientError | null;
  loading: boolean;
  /** Re-sends the current request (after an error). */
  retry: () => void;
  /** Stores a quote fetched elsewhere (e.g. the coupon Apply button) for its request. */
  prime: (body: QuoteRequestBody, data: QuoteDto) => void;
  key: string;
};

type State = { data: QuoteDto | null; dataKey: string | null; error: ApiClientError | null; errorKey: string | null };

const INITIAL: State = { data: null, dataKey: null, error: null, errorKey: null };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useQuote(body: QuoteRequestBody, opts: { enabled: boolean; scope?: string }): UseQuoteResult {
  const scope = opts.scope ?? "";
  const key = quoteKey(body, scope);
  const [state, setState] = React.useState<State>(INITIAL);
  const [nonce, setNonce] = React.useState(0);
  const cache = React.useRef(new Map<string, QuoteDto>());
  const hasData = state.data !== null;

  const remember = React.useCallback((k: string, data: QuoteDto) => {
    const c = cache.current;
    c.delete(k);
    c.set(k, data);
    while (c.size > CACHE_SIZE) {
      const oldest = c.keys().next().value;
      if (oldest === undefined) break;
      c.delete(oldest);
    }
  }, []);

  React.useEffect(() => {
    if (!opts.enabled || body.items.length === 0) return;
    const cached = cache.current.get(key);
    if (cached) {
      setState({ data: cached, dataKey: key, error: null, errorKey: null });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        fetchQuote(body, controller.signal).then(
          (data) => {
            remember(key, data);
            setState({ data, dataKey: key, error: null, errorKey: null });
          },
          (error: unknown) => {
            if (isAbort(error)) return;
            const apiError =
              error instanceof ApiClientError ? error : new ApiClientError(0, "unexpected", UNEXPECTED_ERROR_MESSAGE);
            setState((prev) => ({ ...prev, error: apiError, errorKey: key }));
          },
        );
      },
      hasData ? QUOTE_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` encodes `body` (and scope) completely; hasData only picks the delay and must not re-run the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opts.enabled, nonce, remember]);

  const prime = React.useCallback(
    (primed: QuoteRequestBody, data: QuoteDto) => remember(quoteKey(primed, scope), data),
    [remember, scope],
  );
  const retry = React.useCallback(() => {
    setState((prev) => ({ ...prev, error: null, errorKey: null }));
    setNonce((n) => n + 1);
  }, []);

  const current = state.dataKey === key;
  const error = state.errorKey === key ? state.error : null;
  return {
    data: state.data,
    current,
    error,
    loading: opts.enabled && body.items.length > 0 && !current && error === null,
    retry,
    prime,
    key,
  };
}
