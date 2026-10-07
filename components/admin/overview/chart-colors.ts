/**
 * Chart colours of the Overview and Reports (Admin Console.dc.html), taken from lib/design/tokens.ts. Server-safe.
 * Every colour is paired with a visible label and count (legend, row label or table), never colour alone.
 */
import type { PaymentStatusKey } from "@/lib/admin/overview/model";
import { chartColors, palette, tones, type Tone } from "@/lib/design/tokens";
import type { DerivedLicenseStatus } from "@/lib/licensing/status";

/** Prototype PC: paid #2F8F5B, pending #C26A1F, failed #C2416B, refunded #6355CF, canceled #9AA3B2. */
export const PAYMENT_STATUS_COLORS: Readonly<Record<PaymentStatusKey, string>> = {
  paid: palette.success.DEFAULT,
  pending: palette.warn.bar,
  failed: palette.danger.border,
  refunded: palette.primary.DEFAULT,
  canceled: chartColors[6],
};

/**
 * Prototype H: active #2F8F5B, expiring #C26A1F, trial #3A72C4, expired #9AA3B2, suspended #C2416B and revoked
 * #7A1F33, which has no token; revoked uses danger (#A3273F), the darkest red in the tokens.
 */
export const LICENSE_HEALTH_COLORS: Readonly<Record<DerivedLicenseStatus, string>> = {
  active: palette.success.DEFAULT,
  expiring: palette.warn.bar,
  trial: chartColors[5],
  expired: chartColors[6],
  suspended: palette.danger.border,
  revoked: palette.danger.DEFAULT,
};

/** Revenue bars: the latest bucket in primary, the others in primary.accent (prototype). */
export const REVENUE_BAR = { current: palette.primary.DEFAULT, past: palette.primary.accent } as const;

/** Product bars use the product's tone foreground (prototype T[p.tone].fg). */
export function toneBar(tone: Tone): string {
  return tones[tone].fg;
}
