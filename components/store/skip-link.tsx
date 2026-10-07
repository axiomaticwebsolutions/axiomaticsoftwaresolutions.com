import { cn } from "@/lib/utils";

export type SkipLinkProps = {
  /** Id of the element to jump to (the store layout's <main id="main" tabIndex={-1}>). */
  targetId?: string;
  className?: string;
};

/**
 * "Skip to content" (prototype Home): off-screen until focused, then shown top-left above the sticky header.
 * The target needs tabIndex={-1} so focus moves with the jump. Server-safe.
 */
export function SkipLink({ targetId = "main", className }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className={cn(
        "fixed left-[-9999px] top-2 z-[100] rounded-8 bg-ink px-3 py-2 text-[15px] font-bold text-white no-underline",
        "focus:left-2 focus-visible:outline-white",
        className,
      )}
    >
      Skip to content
    </a>
  );
}
