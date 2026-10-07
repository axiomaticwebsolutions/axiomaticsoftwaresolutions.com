"use client";

import type * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";

/** FAQ accordion. Use type="single" collapsible with the first item open by default (prototype behaviour). */
export function Accordion(props: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

export function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-line last:border-b-0", className)}
      {...props}
    />
  );
}

export type AccordionTriggerProps = React.ComponentProps<typeof AccordionPrimitive.Trigger> & {
  /** Heading level wrapping the button (h3 by default, as in the prototypes). */
  headingLevel?: 2 | 3 | 4;
};

export function AccordionTrigger({ className, children, headingLevel = 3, ...props }: AccordionTriggerProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <AccordionPrimitive.Header asChild>
      <Heading className="flex">
        <AccordionPrimitive.Trigger
          data-slot="accordion-trigger"
          className={cn(
            "group flex flex-1 cursor-pointer items-center justify-between gap-4 rounded-10 py-4 text-left text-[16px] font-bold leading-snug text-ink",
            "transition-colors hover:text-primary-link disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
          {...props}
        >
          {children}
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-9 bg-lavender-soft text-primary-link"
          >
            <Icon name="add" size={20} className="group-data-[state=open]:hidden" />
            <Icon name="remove" size={20} className="hidden group-data-[state=open]:block" />
          </span>
        </AccordionPrimitive.Trigger>
      </Heading>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pb-4 pr-12 text-[15px] leading-relaxed text-ink-2", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
