import type { ResolvedStep } from "@/content/docs/values";
import { cn } from "@/lib/utils";

export type StepListProps = {
  steps: readonly ResolvedStep[];
  className?: string;
};

/**
 * Numbered steps: a 32px lavender number tile (decorative; the ordered list carries the numbering), a 16px/800 title,
 * 15px/1.65 body and an optional monospace chip (file name, key format). Server-safe.
 */
export function StepList({ steps, className }: StepListProps) {
  return (
    <ol className={cn("m-0 grid list-none gap-3.5 p-0", className)}>
      {steps.map((step, index) => (
        <li key={`${index}-${step.title}`} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3.5">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-10 bg-lavender-bg text-[14px] font-extrabold text-lavender-fg"
          >
            {index + 1}
          </span>
          <div>
            <h3 className="text-[16px] font-extrabold leading-[normal] [text-wrap:wrap]">{step.title}</h3>
            <p className="mt-1 text-[15px] leading-[1.65] text-ink-soft">{step.body}</p>
            {step.code ? (
              <code className="mt-2 inline-block max-w-full rounded-8 bg-slate-bg px-2.5 py-1.5 font-mono text-[13.5px] leading-[normal] [overflow-wrap:anywhere]">
                {step.code}
              </code>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
