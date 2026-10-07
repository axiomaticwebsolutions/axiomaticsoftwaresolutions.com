/**
 * Admin action button looks (Admin Console.dc.html `btn()`), server-safe so server components (not-found, notices)
 * can style links like AdminAction.
 */
import { cn } from "@/lib/utils";

/** Prototype button kinds: primary (filled), default (outline) and danger (white with a pink border). */
export type AdminActionVariant = "primary" | "default" | "danger";
/** md: page-header actions (13.5px, 18px icon); sm: drawer footer (13px, 17px icon); xs: drawer section rows (12px). */
export type AdminActionSize = "md" | "sm" | "xs";

export const ACTION_BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap border font-bold leading-[normal] no-underline transition-colors aria-busy:cursor-progress";

export const ACTION_SIZES: Record<AdminActionSize, { box: string; icon: number }> = {
  md: { box: "gap-1.5 rounded-9 px-[13px] py-[7px] text-[13.5px]", icon: 18 },
  sm: { box: "gap-1.5 rounded-9 px-[13px] py-[7px] text-[13px]", icon: 17 },
  xs: { box: "gap-1 rounded-8 px-2.5 py-[3px] text-[12px]", icon: 15 },
};

export const ACTION_VARIANTS: Record<AdminActionVariant, { look: string; hover: string; spinner: "primary" | "onPrimary" }> = {
  primary: { look: "border-primary bg-primary text-white", hover: "hover:border-primary-hover hover:bg-primary-hover hover:text-white", spinner: "onPrimary" },
  default: { look: "border-line-input bg-surface text-ink", hover: "hover:border-primary hover:text-ink", spinner: "primary" },
  danger: { look: "border-pink-line bg-surface text-danger", hover: "hover:border-danger-border hover:bg-pink-soft hover:text-danger", spinner: "primary" },
};

/** Inactive look (exempt from contrast rules as inactive UI), like the prototype's `button:disabled { opacity: .5 }`. */
export const ACTION_UNAVAILABLE = "cursor-not-allowed opacity-50";

/** Classes of an admin action button or link (for elements AdminAction cannot render, e.g. a menu trigger). */
export function adminActionClassName(variant: AdminActionVariant = "default", size: AdminActionSize = "md", className?: string): string {
  return cn(ACTION_BASE, ACTION_SIZES[size].box, ACTION_VARIANTS[variant].look, ACTION_VARIANTS[variant].hover, className);
}
