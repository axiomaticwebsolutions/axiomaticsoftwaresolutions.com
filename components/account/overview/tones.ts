/**
 * Tone classes shared by the Overview and Software & downloads views (prototype TONES: bg, fg, soft, line). Literal
 * class strings so Tailwind finds them; every pair is a README token pair (fg on bg >= 4.5:1). Pure and client-safe.
 */
import { TONE_NAMES, type Tone } from "@/lib/design/tokens";

export type ToneClasses = {
  /** Icon tiles and pills: tone bg + fg. */
  tile: string;
  /** Alert / callout surface: tone bg + 1px tone line. */
  callout: string;
  /** Icon colour on a callout. */
  fg: string;
  /** Solid bar in the tone's fg (spend by product). */
  bar: string;
};

export const TONE_CLASSES: Readonly<Record<Tone, ToneClasses>> = {
  lavender: {
    tile: "bg-lavender-bg text-lavender-fg",
    callout: "border-lavender-line bg-lavender-bg",
    fg: "text-lavender-fg",
    bar: "bg-lavender-fg",
  },
  sage: { tile: "bg-sage-bg text-sage-fg", callout: "border-sage-line bg-sage-bg", fg: "text-sage-fg", bar: "bg-sage-fg" },
  blue: { tile: "bg-blue-bg text-blue-fg", callout: "border-blue-line bg-blue-bg", fg: "text-blue-fg", bar: "bg-blue-fg" },
  peach: { tile: "bg-peach-bg text-peach-fg", callout: "border-peach-line bg-peach-bg", fg: "text-peach-fg", bar: "bg-peach-fg" },
  pink: { tile: "bg-pink-bg text-pink-fg", callout: "border-pink-line bg-pink-bg", fg: "text-pink-fg", bar: "bg-pink-fg" },
};

/** A tone name from data (product, category, API), else `fallback`. */
export function toTone(value: string | null | undefined, fallback: Tone = "lavender"): Tone {
  return value && (TONE_NAMES as readonly string[]).includes(value) ? (value as Tone) : fallback;
}

export function toneClasses(value: string | null | undefined, fallback: Tone = "lavender"): ToneClasses {
  return TONE_CLASSES[toTone(value, fallback)];
}
