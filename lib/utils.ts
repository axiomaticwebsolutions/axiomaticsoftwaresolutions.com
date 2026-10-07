import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { fontSizes, radii, shadows } from "@/lib/design/tokens";

/*
 * tailwind-merge only knows Tailwind's default scales. Without this, custom tokens are misclassified:
 * `text-overline` (a font size) would be treated as a text colour and dropped by `text-ink-2`, and
 * `rounded-12` / `shadow-menu` would never override each other.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: Object.keys(fontSizes),
      radius: Object.keys(radii),
      shadow: Object.keys(shadows),
      // max-w-store / max-w-portal / max-w-admin (tailwind.config.mts maxWidth), so `max-w-[880px]` overrides them.
      container: ["store", "portal", "admin"],
      // tailwind.config.mts animations plus the tw-animate-css ones used by overlays.
      animate: ["skeleton", "spin-fast", "enter-up", "drawer-in", "in", "out", "accordion-down", "accordion-up"],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (later classes win), aware of the design tokens. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
