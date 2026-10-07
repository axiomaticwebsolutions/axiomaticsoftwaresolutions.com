import type { Tone } from "@/lib/design/tokens";

/**
 * Tone utilities the Home sections need separately (Tailwind only generates class names written out in full, so
 * they are spelled out per tone). For a tinted tile with both colours use TONE_TILE_CLASSES from
 * components/store/active-nav.ts.
 */
export type ToneClasses = {
  /** Tinted background (bg token). */
  bg: string;
  /** Foreground text/icon colour on white or on the tinted background (fg token, >= 4.5:1 on both). */
  fg: string;
  /** The fg colour as a background (decorative bars). */
  fill: string;
};

export const HOME_TONE_CLASSES: Readonly<Record<Tone, ToneClasses>> = {
  lavender: { bg: "bg-lavender-bg", fg: "text-lavender-fg", fill: "bg-lavender-fg" },
  sage: { bg: "bg-sage-bg", fg: "text-sage-fg", fill: "bg-sage-fg" },
  blue: { bg: "bg-blue-bg", fg: "text-blue-fg", fill: "bg-blue-fg" },
  peach: { bg: "bg-peach-bg", fg: "text-peach-fg", fill: "bg-peach-fg" },
  pink: { bg: "bg-pink-bg", fg: "text-pink-fg", fill: "bg-pink-fg" },
};

/**
 * Overline line box. Home's overlines are inline spans in a 16px line (line-height normal = 21.86px for Manrope),
 * so the gap above the heading is taller than SectionHeading's default 12.5px x 1.4. Pass as overlineClassName.
 */
export const HOME_OVERLINE_LINE = "leading-[21.86px]";

/**
 * Headings wrap normally: the prototype balances only the hero H1 and the "Why Axiomatic" H2, while app/globals.css
 * balances every h1-h4.
 */
export const WRAP = "text-wrap";

/**
 * Icon line boxes. The prototype's icons are Material Symbols glyphs whose "normal" line box is about 1.2x the font
 * size, which sets the height of icon + text rows. The SVG keeps its glyph width and centres inside the taller box.
 */
export const ICON_LINE_BOX = {
  19: "h-[23px]",
  20: "h-[24px]",
  21: "h-[25px]",
} as const;
