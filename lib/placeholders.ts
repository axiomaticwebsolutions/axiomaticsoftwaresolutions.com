/**
 * Placeholder values from `.env.example` and deploy/.env.production.example ("change-me", "xxxxxxxx", "..."). lib/env.ts
 * refuses them in secrets, and the Admin integration forms refuse them as secrets (lib/integrations/model.ts).
 *
 * Pure and dependency-free: the browser bundle (Admin forms), lib/env.ts and the deploy preflight all import it.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [/change-?me/i, /x{8,}/i, /\.\.\./];

/** True for the placeholder values used in `.env.example`. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}
