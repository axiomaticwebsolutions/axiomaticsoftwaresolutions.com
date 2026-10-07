/**
 * Small shared pieces of the portal license and device views: the product's tone tile, the license status pill,
 * tone class maps (static strings, so Tailwind sees them) and the prototype's small outline/danger buttons.
 * Server-safe (no hooks).
 */
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES, toIconName } from "@/components/store/active-nav";
import { Badge } from "@/components/ui/badge";
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";
import { LICENSE_STATUS_META, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { cn } from "@/lib/utils";

export function toTone(value: string | null | undefined, fallback: Tone = "lavender"): Tone {
  return value && (TONE_NAMES as readonly string[]).includes(value) ? (value as Tone) : fallback;
}

/** Tinted callouts (status explanation): tone background, tone line border. */
export const TONE_CALLOUT_CLASSES: Readonly<Record<Tone, string>> = {
  lavender: "border-lavender-line bg-lavender-bg",
  sage: "border-sage-line bg-sage-bg",
  blue: "border-blue-line bg-blue-bg",
  peach: "border-peach-line bg-peach-bg",
  pink: "border-pink-line bg-pink-bg",
};

export const TONE_TEXT_CLASSES: Readonly<Record<Tone, string>> = {
  lavender: "text-lavender-fg",
  sage: "text-sage-fg",
  blue: "text-blue-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
};

/** Product icon on its category tone: 32px / radius 9 in tables, 46px / radius 13 in the license header. */
export function ProductTile({ icon, tone, size = "sm", className }: { icon: string; tone: string; size?: "sm" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center",
        size === "lg" ? "size-[46px] rounded-13" : "size-8 rounded-9",
        TONE_TILE_CLASSES[toTone(tone)],
        className,
      )}
    >
      <Icon name={toIconName(icon)} size={size === "lg" ? 25 : 18} />
    </span>
  );
}

/** License status pill (prototype LB badges): sm in tables (3x9px, 12px), md in the license header (5x12px). */
export function LicenseStatusBadge({ status, size = "sm", className }: { status: DerivedLicenseStatus; size?: "sm" | "md"; className?: string }) {
  const meta = LICENSE_STATUS_META[status];
  return (
    <Badge
      tone={meta.tone}
      className={cn(size === "md" ? "px-3 py-[5px] text-[12.5px]" : "px-[9px] py-[3px] text-[12px]", "leading-[normal]", className)}
    >
      {meta.label}
    </Badge>
  );
}

/** Prototype small row buttons ("Manage", "Deactivate"): 6x12px, radius 9, 13px/700. */
export const SMALL_BUTTON =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-9 border bg-surface px-3 py-1.5 text-[13px] font-bold leading-[normal] no-underline transition-colors";
export const SMALL_OUTLINE = cn(SMALL_BUTTON, "border-line-input text-ink hover:border-primary hover:text-ink");
export const SMALL_DANGER = cn(SMALL_BUTTON, "border-pink-line text-danger hover:border-danger-border hover:bg-pink-soft");

/** A card section of the license pages (white, 1px line, radius 16). */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("rounded-16 border border-line-alt bg-surface", className)} {...props} />;
}
