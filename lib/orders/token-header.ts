/**
 * The request header that carries the order link token on the order page's own API calls (client-safe, no imports).
 *
 * The order page polls GET /api/orders/:id/status every 2 s. With the token in `?t=` every poll would put a 30-day
 * credential into request lines, and Nginx writes the full request line (query string included) to the site's error
 * log whenever the app does not answer, e.g. during the few seconds of every fork-mode restart. Headers never reach
 * that log. lib/checkout/request.ts orderTokenFrom() reads the body's `t`, then this header, then `?t=` (kept for the
 * page URL and the invoice PDF link, owner decision S2).
 */
export const ORDER_TOKEN_HEADER = "x-order-token";
