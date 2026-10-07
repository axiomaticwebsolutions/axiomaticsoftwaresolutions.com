"use client";

import { Accordion as AccordionPrimitive } from "radix-ui";
import { Icon } from "@/components/icons/icon";
import { Accordion, AccordionItem } from "@/components/ui/accordion";
import { VisuallyHidden } from "@/components/ui/visually-hidden";

export type ReleaseHistoryItem = {
  version: string;
  dateLabel: string;
  notes: readonly string[];
};

/**
 * "Earlier versions": one disclosure per older release, all closed at first, one open at a time (prototype). The
 * shared Accordion root and item; the trigger shows the version, its IST date and a chevron (expand_more/less).
 */
export function ReleaseHistory({ releases }: { releases: readonly ReleaseHistoryItem[] }) {
  return (
    <Accordion type="single" collapsible>
      {releases.map((r) => (
        <AccordionItem key={r.version} value={r.version} className="border-b-0 border-t border-line-subtle">
          <AccordionPrimitive.Header asChild>
            <h4 className="m-0 flex">
              <AccordionPrimitive.Trigger className="group flex w-full cursor-pointer items-center justify-between gap-4 rounded-8 bg-transparent py-3.5 text-left text-[16px] leading-[normal] text-ink">
                {/* The comma is for screen readers: without text between the spans the name runs together
                    ("Version 4.2.02 Jul 2026"); on screen the 10px margin separates them. */}
                <span>
                  <span className="font-extrabold">Version {r.version}</span>
                  <VisuallyHidden>, released </VisuallyHidden>
                  <span className="ml-2.5 text-[14px] font-semibold text-ink-2">{r.dateLabel}</span>
                </span>
                <Icon name="expand_more" size={22} className="my-0.5 group-data-[state=open]:hidden" />
                <Icon name="expand_less" size={22} className="my-0.5 hidden group-data-[state=open]:block" />
              </AccordionPrimitive.Trigger>
            </h4>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
            <ul className="m-0 grid list-disc gap-1.5 pb-4 pl-5 text-[15px] text-ink-soft">
              {r.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AccordionPrimitive.Content>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
