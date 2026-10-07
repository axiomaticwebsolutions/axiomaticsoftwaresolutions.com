import { LogoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

/**
 * Decorative hero panel (prototype About hero): lavender 5:4 panel with the logo mark on a white tile and tinted
 * shapes. Every shape is aria-hidden; the optional label says a real photo goes here and stays readable.
 */
export function AboutHeroArt({ label, className }: { label: string | null; className?: string }) {
  return (
    <div className={cn("relative aspect-[5/4] overflow-hidden rounded-32 bg-lavender-bg", className)}>
      <div
        aria-hidden="true"
        className="absolute left-[12%] top-[14%] grid h-[44%] w-[44%] place-items-center rounded-28 bg-surface shadow-card-hover"
      >
        <LogoMark className="h-auto w-[44%]" />
      </div>
      <div aria-hidden="true" className="absolute right-[10%] top-[22%] h-[30%] w-[30%] rounded-[50%] bg-sage-bg" />
      <div aria-hidden="true" className="absolute bottom-[12%] right-[16%] h-[24%] w-[40%] rounded-22 bg-peach-bg" />
      <div aria-hidden="true" className="absolute bottom-[14%] left-[18%] h-[22%] w-[22%] rounded-18 bg-blue-bg" />
      {label ? (
        <span className="absolute bottom-3.5 left-4 rounded-pill bg-ink px-3 py-1.5 text-[12.5px] font-bold leading-[normal] text-white">
          {label}
        </span>
      ) : null}
    </div>
  );
}
