/**
 * Product tone classes for the product page (README > Design tokens: bg, fg, soft, line per tone). Literal class
 * names, so Tailwind finds them in source. Pure and client-safe.
 */
import type { Tone } from "@/lib/design/tokens";

export type ProductToneClasses = {
  /** Soft background: hero band, latest-release panel. */
  soft: string;
  /** Tinted background: tags, benefits band, OS chips. */
  bg: string;
  /** Foreground on white or tinted backgrounds (icons, tag text). */
  fg: string;
  /** Border in the tone's line colour (hero bottom border, category pill). */
  line: string;
  /** Icon tile: tinted background + foreground. */
  tile: string;
};

export const PRODUCT_TONES: Readonly<Record<Tone, ProductToneClasses>> = {
  lavender: {
    soft: "bg-lavender-soft",
    bg: "bg-lavender-bg",
    fg: "text-lavender-fg",
    line: "border-lavender-line",
    tile: "bg-lavender-bg text-lavender-fg",
  },
  sage: {
    soft: "bg-sage-soft",
    bg: "bg-sage-bg",
    fg: "text-sage-fg",
    line: "border-sage-line",
    tile: "bg-sage-bg text-sage-fg",
  },
  blue: {
    soft: "bg-blue-soft",
    bg: "bg-blue-bg",
    fg: "text-blue-fg",
    line: "border-blue-line",
    tile: "bg-blue-bg text-blue-fg",
  },
  peach: {
    soft: "bg-peach-soft",
    bg: "bg-peach-bg",
    fg: "text-peach-fg",
    line: "border-peach-line",
    tile: "bg-peach-bg text-peach-fg",
  },
  pink: {
    soft: "bg-pink-soft",
    bg: "bg-pink-bg",
    fg: "text-pink-fg",
    line: "border-pink-line",
    tile: "bg-pink-bg text-pink-fg",
  },
};

/** Value colours in the placeholder screenshots (prototype: #8A4B12 warn, #A3273F danger, #1F6B45 ok). */
export const VALUE_TONE_CLASSES = {
  default: "text-ink",
  warn: "text-peach-fg",
  danger: "text-pink-fg",
  ok: "text-sage-fg",
} as const;

export type ValueTone = keyof typeof VALUE_TONE_CLASSES;
