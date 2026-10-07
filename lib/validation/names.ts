/**
 * Person names (register, checkout billing) are greeted in emails sent to whatever address was typed with them, so a
 * name may not carry a link or an email address. Emails also fall back to "there" for anything link-like
 * (lib/email/greeting.ts); this rule only stops the obvious cases at the form. Client-safe.
 */
export const NAME_LINK_RE = /@|:\/\/|www\./i;

/** New copy (no prototype equivalent). */
export const NAME_LINK_ERROR = "Enter your name without links or email addresses.";

export function isLinkLikeName(value: string): boolean {
  return NAME_LINK_RE.test(value);
}
