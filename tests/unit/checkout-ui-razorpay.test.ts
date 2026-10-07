import { afterEach, describe, expect, it, vi } from "vitest";
import { orderActionPath, startHostedCheckout } from "@/components/checkout/hosted-checkout";
import {
  loadRazorpay,
  RAZORPAY_SCRIPT_URL,
  RazorpayLoadError,
  razorpayOptions,
  resetRazorpayLoader,
  type RazorpayConstructor,
  type RazorpayOptions,
  type RazorpayPayload,
} from "@/components/checkout/razorpay";
import type { CheckoutStart } from "@/lib/checkout/payment-attempt";
import { palette } from "@/lib/design/tokens";

const payload: RazorpayPayload = {
  kind: "razorpay",
  keyId: "rzp_test_123",
  providerOrderId: "order_ABC",
  amountPaise: 589882,
  currency: "INR",
  name: "Axiomatic Software Solutions",
  description: "Order AX-10312",
  prefill: { name: "Priya", email: "priya@example.com", contact: "9820000000" },
};

/** A <script> stand-in: listeners fire when the test calls fire(). */
class FakeScript {
  src = "";
  async = false;
  removed = false;
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, cb: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  remove() {
    this.removed = true;
  }
  fire(type: "load" | "error") {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

function fakeEnv() {
  const scripts: FakeScript[] = [];
  const win: { Razorpay?: RazorpayConstructor } = {};
  const document = {
    querySelector: () => scripts.find((s) => !s.removed && s.src === RAZORPAY_SCRIPT_URL) ?? null,
    createElement: () => {
      const s = new FakeScript();
      return s;
    },
    head: { appendChild: (s: FakeScript) => scripts.push(s) },
  };
  return { env: { document: document as unknown as Document, window: win }, scripts, win };
}

afterEach(() => {
  resetRazorpayLoader();
  vi.useRealTimers();
});

describe("razorpayOptions", () => {
  it("maps the order payload to Checkout.js options with the brand colour", () => {
    const onSuccess = vi.fn();
    const onDismiss = vi.fn();
    const options = razorpayOptions(payload, { onSuccess, onDismiss });
    expect(options).toMatchObject({
      key: "rzp_test_123",
      amount: 589882,
      currency: "INR",
      order_id: "order_ABC",
      name: "Axiomatic Software Solutions",
      description: "Order AX-10312",
      prefill: { name: "Priya", email: "priya@example.com", contact: "9820000000" },
      theme: { color: palette.primary.DEFAULT },
      modal: { escape: true, backdropclose: false, confirm_close: true },
    });
    options.modal.ondismiss();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("loadRazorpay", () => {
  it("adds the script once and shares the load between callers", async () => {
    const { env, scripts, win } = fakeEnv();
    const a = loadRazorpay(env);
    const b = loadRazorpay(env);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(RAZORPAY_SCRIPT_URL);
    const ctor = function Razorpay() {} as unknown as RazorpayConstructor;
    win.Razorpay = ctor;
    scripts[0]?.fire("load");
    await expect(a).resolves.toBe(ctor);
    await expect(b).resolves.toBe(ctor);
    await expect(loadRazorpay(env)).resolves.toBe(ctor);
    expect(scripts).toHaveLength(1);
  });

  it("rejects on a network error and tries again on the next call", async () => {
    const { env, scripts } = fakeEnv();
    const first = loadRazorpay(env);
    scripts[0]?.fire("error");
    await expect(first).rejects.toBeInstanceOf(RazorpayLoadError);
    expect(scripts[0]?.removed).toBe(true);
    void loadRazorpay(env).catch(() => {});
    expect(scripts).toHaveLength(2);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const { env } = fakeEnv();
    const pending = loadRazorpay(env, 1000);
    const check = expect(pending).rejects.toBeInstanceOf(RazorpayLoadError);
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });
});

describe("startHostedCheckout", () => {
  const base = { orderId: "AX-10312", orderToken: "o1.tok", statusUrl: "/orders/AX-10312?t=o1.tok" };

  function razorpayStub() {
    const opened: RazorpayOptions[] = [];
    const ctor = function Razorpay(this: { open: () => void }, options: RazorpayOptions) {
      this.open = () => opened.push(options);
    } as unknown as RazorpayConstructor;
    return { opened, load: () => Promise.resolve(ctor) };
  }

  it("navigates to the mock checkout page in development", async () => {
    const navigate = vi.fn();
    const start: CheckoutStart = { ...base, checkout: { kind: "mock", url: "/dev/mock-checkout?order=AX-10312&t=o1.tok" } };
    await startHostedCheckout(start, { navigate, post: vi.fn() });
    expect(navigate).toHaveBeenCalledWith("/dev/mock-checkout?order=AX-10312&t=o1.tok");
  });

  it("posts the signed Razorpay response to /return, then opens the order page (once)", async () => {
    const navigate = vi.fn();
    const post = vi.fn().mockResolvedValue({ status: "CONFIRMING" });
    const { opened, load } = razorpayStub();
    await startHostedCheckout({ ...base, checkout: payload }, { navigate, post, load });
    expect(opened).toHaveLength(1);
    const options = opened[0] as RazorpayOptions;
    options.handler({ razorpay_payment_id: "pay_1", razorpay_order_id: "order_ABC", razorpay_signature: "sig" });
    options.modal.ondismiss();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(orderActionPath("AX-10312", "return"), {
      providerPaymentId: "pay_1",
      providerSignature: "sig",
      t: "o1.tok",
    });
    expect(navigate).toHaveBeenCalledWith(base.statusUrl);
  });

  it("cancels the order when the modal is closed, and still lands on the order page if that fails", async () => {
    const navigate = vi.fn();
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    const { opened, load } = razorpayStub();
    await startHostedCheckout({ ...base, checkout: payload }, { navigate, post, load });
    opened[0]?.modal.ondismiss();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(base.statusUrl));
    expect(post).toHaveBeenCalledWith("/api/checkout/orders/AX-10312/cancel", { t: "o1.tok" });
  });

  it("rejects when Checkout.js cannot load (the caller links to the order)", async () => {
    const navigate = vi.fn();
    await expect(
      startHostedCheckout({ ...base, checkout: payload }, { navigate, post: vi.fn(), load: () => Promise.reject(new RazorpayLoadError()) }),
    ).rejects.toBeInstanceOf(RazorpayLoadError);
    expect(navigate).not.toHaveBeenCalled();
  });
});
