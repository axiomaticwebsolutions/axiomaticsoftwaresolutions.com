/**
 * Focus-return target for overlays (DOM only, no React), shared by useReturnFocus in dialog.tsx.
 * Kept in a plain .ts module so it can be unit-tested without a JSX transform.
 */

const MAX_MENU_DEPTH = 5;

function menuTrigger(menu: Element): Element | null {
  const doc = menu.ownerDocument;
  // Radix menus are labelled by their trigger; aria-controls on the trigger is only set while the menu is open.
  const labelledBy = menu.getAttribute("aria-labelledby");
  const byLabel = labelledBy ? doc.getElementById(labelledBy) : null;
  if (byLabel) return byLabel;
  return menu.id ? doc.querySelector(`[aria-controls="${menu.id.replace(/["\\]/g, "\\$&")}"]`) : null;
}

/**
 * Where focus should go back to when an overlay closes: the element that opened it, or, when that element is a menu
 * item (menus unmount on select, so the item is gone by then), the trigger of its menu, climbing out of submenus.
 * Null when nothing focusable was recorded.
 */
export function returnFocusTarget(active: Element | null): HTMLElement | null {
  let target = active;
  for (let depth = 0; target && depth < MAX_MENU_DEPTH; depth += 1) {
    const menu = target.closest('[role="menu"]');
    if (!menu) break;
    target = menuTrigger(menu);
  }
  if (!target || target === target.ownerDocument.body) return null;
  return typeof (target as HTMLElement).focus === "function" ? (target as HTMLElement) : null;
}
