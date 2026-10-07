import type * as React from "react";
import { cn } from "@/lib/utils";

/** A titled gallery section with an anchor id. */
export function GallerySection({
  id,
  title,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("grid scroll-mt-6 gap-5", className)}>
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="text-[24px] font-extrabold tracking-[-0.02em]">
          {title}
        </h2>
        {description ? <p className="max-w-[720px] text-[15px] text-ink-2">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A labelled demo tile inside a section. */
export function Demo({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-3 rounded-16 border border-line bg-surface p-4 sm:p-5", className)}>
      <h3 className="text-overline uppercase text-ink-2">{title}</h3>
      {children}
    </div>
  );
}

/** Responsive grid of demo tiles that never forces horizontal scroll (min 300px or the full width). */
export function DemoGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4", className)}>{children}</div>
  );
}
