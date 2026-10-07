import { SCREENSHOT_BADGE, SCREENSHOT_EXTRA_NAV, type ProductScreenshot } from "@/content/screenshots";
import type { Tone } from "@/lib/design/tokens";
import { cn } from "@/lib/utils";
import { PRODUCT_COPY } from "./copy";
import { PRODUCT_TONES, VALUE_TONE_CLASSES } from "./tones";

export type PlaceholderScreenshotProps = {
  shortName: string;
  tone: Tone;
  /** Every panel of the product (their tab labels fill the side navigation). */
  shots: readonly ProductScreenshot[];
  /** Index of the panel to draw. */
  index: number;
  className?: string;
};

/**
 * HTML placeholder of the product UI (role="img" with a descriptive label; the visible "Placeholder screenshot"
 * badge says it is illustrative). Sized with container query units, so it scales with its column like an image.
 * Server-safe (no hooks).
 */
export function PlaceholderScreenshot({ shortName, tone, shots, index, className }: PlaceholderScreenshotProps) {
  const shot = shots[index] ?? shots[0];
  if (!shot) return null;
  const t = PRODUCT_TONES[tone];
  const nav = [...shots.map((s) => s.tab), ...SCREENSHOT_EXTRA_NAV];

  return (
    <div
      role="img"
      aria-label={PRODUCT_COPY.screenshotAria(shortName, shot.title)}
      className={cn(
        "@container relative overflow-hidden rounded-22 bg-surface shadow-[0_30px_70px] shadow-ink/14 ring-1 ring-ink/6",
        className,
      )}
    >
      <div className="flex items-center gap-[1cqw] border-b border-line-subtle bg-bg/50 px-[2.4cqw] py-[1.8cqw] text-[2cqw]">
        <span className="size-[1.4cqw] rounded-full bg-pink-bg" />
        <span className="size-[1.4cqw] rounded-full bg-peach-bg" />
        <span className="size-[1.4cqw] rounded-full bg-sage-bg" />
        <span className="ml-[1.4cqw] font-bold text-ink-2">
          {shortName} — {shot.title}
        </span>
      </div>
      <div className="grid min-h-[46cqw] grid-cols-[16cqw_1fr] text-[2cqw]">
        <div className="grid content-start gap-[1cqw] border-r border-line-subtle bg-bg px-[1.4cqw] py-[2cqw] font-semibold text-ink-2">
          {nav.map((label, i) => (
            <span
              key={`${label}-${i}`}
              className={cn("rounded-[1cqw] px-[1.2cqw] py-[0.9cqw]", i === index && cn(t.bg, t.fg))}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="p-[2.4cqw]">
          <div className="text-[2.8cqw] font-extrabold tracking-[-0.02em]">{shot.heading}</div>
          <div className="mt-[2cqw] grid grid-cols-[1fr_auto] gap-x-[2cqw] gap-y-[1.5cqw]">
            {shot.rows.map((r, i) => (
              <div key={`${r.label}-${i}`} className="contents">
                <span className="font-semibold">{r.label}</span>
                <span className={cn("text-right font-bold", VALUE_TONE_CLASSES[r.tone ?? "default"])}>{r.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-[2.4cqw] flex justify-between border-t border-dashed border-line-strong pt-[1.8cqw] text-[2.6cqw] font-extrabold">
            <span>{shot.foot[0]}</span>
            <span>{shot.foot[1]}</span>
          </div>
        </div>
      </div>
      <span className="absolute bottom-[2cqw] right-[2cqw] rounded-pill bg-ink px-[1.6cqw] py-[0.8cqw] text-[1.7cqw] font-bold text-white">
        {SCREENSHOT_BADGE}
      </span>
    </div>
  );
}
