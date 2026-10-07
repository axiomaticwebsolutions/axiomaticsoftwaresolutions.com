/**
 * Client-safe CSRF names. lib/auth/csrf.ts pulls in node:crypto, so client fetch helpers import these instead:
 * read the readable `axs_csrf` cookie and echo it in the `x-csrf-token` header on every cookie-authenticated mutation.
 */
export const CSRF_COOKIE = "axs_csrf";
export const CSRF_HEADER = "x-csrf-token";
