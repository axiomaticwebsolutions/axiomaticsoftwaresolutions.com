/**
 * Sender addresses ("From"): `Name <address>` or a bare `address`, as EMAIL_FROM and the Admin email form hold them.
 * The transport hands nodemailer `{ name, address }`, never a concatenated string, so a name can never inject headers.
 *
 * Pure and dependency-free (the deploy preflight, lib/env.ts and the browser bundle import it).
 */
export type Mailbox = { name: string; address: string };

const ADDRESS_RE = /^[^\s@<>"(),;:\x5C[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const NAME_MAX = 100;
const ADDRESS_MAX = 254;

/** True for an address such as no-reply@example.com (the domain may be a single label, e.g. localhost, in development). */
export function isMailboxAddress(value: string): boolean {
  return value.length <= ADDRESS_MAX && ADDRESS_RE.test(value);
}

/** True when a display name is usable: at most 100 characters, no line breaks or other control characters, no <, >. */
export function isMailboxName(value: string): boolean {
  return value.length <= NAME_MAX && !CONTROL_RE.test(value) && !/[<>]/.test(value);
}

/** "Name <a@b.c>" | "\"Name\" <a@b.c>" | "<a@b.c>" | "a@b.c" -> { name, address }; null when it does not parse. */
export function parseMailbox(input: string): Mailbox | null {
  const value = input.trim();
  if (value === "" || CONTROL_RE.test(value)) return null;
  const angle = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  let name = "";
  let address = value;
  if (angle) {
    name = (angle[1] ?? "").trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).trim();
    address = (angle[2] ?? "").trim();
  }
  if (!isMailboxAddress(address) || !isMailboxName(name)) return null;
  const at = address.lastIndexOf("@");
  return { name, address: `${address.slice(0, at)}${address.slice(at).toLowerCase()}` };
}

/** "Name <address>" (or just the address), for display and the env file. */
export function formatMailbox(mailbox: Mailbox): string {
  return mailbox.name ? `${mailbox.name} <${mailbox.address}>` : mailbox.address;
}
