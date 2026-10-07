import Link from "next/link";
import { CUSTOMER_HOME, signInPath } from "@/lib/auth/redirect";

export type OrderNotFoundProps = {
  orderId: string;
  /** "expired": a genuine order link past its 30 days (403 order_link_expired); otherwise not found. */
  reason: "not_found" | "expired";
  signedIn: boolean;
};

const LINK = "rounded-6 font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover";

/**
 * Order.dc.html "Order not found". Also shown for orders the viewer may not see and for bad links, so order ids
 * cannot be probed. An expired link gets its own message (the link was genuine).
 */
export function OrderNotFound({ orderId, reason, signedIn }: OrderNotFoundProps) {
  const next = `/orders/${encodeURIComponent(orderId)}`;
  return (
    <div className="mx-auto max-w-[960px] px-6 pt-24 pb-36 text-center leading-[normal]">
      <h1 className="text-[26px] font-extrabold">{reason === "expired" ? "This order link has expired" : "Order not found"}</h1>
      <p className="mt-3 text-ink-2">
        {reason === "expired"
          ? "Sign in with the email you used for the order, or contact support."
          : "Check the link in your email, or sign in to see your orders."}
      </p>
      <p className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2">
        {signedIn ? (
          <Link href={CUSTOMER_HOME} className={LINK}>
            Go to my account
          </Link>
        ) : (
          <Link href={signInPath(next)} className={LINK}>
            Sign in
          </Link>
        )}
        {reason === "expired" ? (
          <Link href="/support" className={LINK}>
            Contact support
          </Link>
        ) : null}
      </p>
    </div>
  );
}
