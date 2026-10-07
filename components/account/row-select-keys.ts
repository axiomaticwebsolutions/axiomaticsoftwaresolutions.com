/**
 * Keyboard rule of the portal's row selects (components/account/row-select.tsx), in a plain module so it can be
 * unit-tested without a JSX transform.
 */

/** Printable keys other than Space: Radix Select's typeahead on a closed trigger picks an option without opening. */
export function isClosedTypeaheadKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}
