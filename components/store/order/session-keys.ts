/**
 * Browser-session hand-offs of an email address between pages (client-only helpers; every access is guarded, so
 * blocked storage never breaks a page). The email never goes into the URL (URLs reach logs and history). Each value
 * is `{ v: 1, email }`, read once: take*() also removes it.
 *
 * - "axiomatic.registerPrefill": written by the order page's "Create account" button; the register form prefills the
 *   order email.
 * - "axiomatic.signInPrefill": written after a password reset (the account's email, as the prototype keeps it) and by
 *   the checkout's "Sign in instead." (the email that already has an account); the sign-in form prefills it.
 *
 * Clearing the cart after payment uses the checkout's own marker (components/checkout/cart-order.ts).
 */

export const REGISTER_PREFILL_KEY = "axiomatic.registerPrefill";
export const SIGN_IN_PREFILL_KEY = "axiomatic.signInPrefill";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function saveEmailHandoff(key: string, email: string, storage: StorageLike | null): void {
  try {
    storage?.setItem(key, JSON.stringify({ v: 1, email }));
  } catch {
    // the next form simply starts empty
  }
}

function takeEmailHandoff(key: string, storage: StorageLike | null): string {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
    storage?.removeItem(key);
  } catch {
    return "";
  }
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; email?: unknown } | null;
    return parsed?.v === 1 && typeof parsed.email === "string" ? parsed.email : "";
  } catch {
    return "";
  }
}

/** Remembers the order email for the register form (this browser tab only). */
export function saveRegisterPrefill(email: string, storage: StorageLike | null = sessionStore()): void {
  saveEmailHandoff(REGISTER_PREFILL_KEY, email, storage);
}

/** Reads and forgets the register prefill. Returns the raw email (the caller validates it) or "". */
export function takeRegisterPrefill(storage: StorageLike | null = sessionStore()): string {
  return takeEmailHandoff(REGISTER_PREFILL_KEY, storage);
}

/** Remembers an account email for the sign-in form (this browser tab only). */
export function saveSignInPrefill(email: string, storage: StorageLike | null = sessionStore()): void {
  saveEmailHandoff(SIGN_IN_PREFILL_KEY, email, storage);
}

/** Reads and forgets the sign-in prefill. Returns the raw email (the caller validates it) or "". */
export function takeSignInPrefill(storage: StorageLike | null = sessionStore()): string {
  return takeEmailHandoff(SIGN_IN_PREFILL_KEY, storage);
}
