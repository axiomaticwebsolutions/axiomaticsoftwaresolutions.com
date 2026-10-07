"use client";

import { useState } from "react";
import type { ProductScreenshot } from "@/content/screenshots";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Tone } from "@/lib/design/tokens";
import { PRODUCT_COPY } from "./copy";
import { PlaceholderScreenshot } from "./placeholder-screenshot";

export type ScreenshotTabsProps = {
  shortName: string;
  tone: Tone;
  shots: readonly ProductScreenshot[];
};

/**
 * Hero screenshot panel with its tabs underneath (prototype order: panel, then the tab row). Radix Tabs: arrow keys
 * move between tabs, each tab controls its panel (aria-controls), only the selected panel is rendered.
 */
export function ScreenshotTabs({ shortName, tone, shots }: ScreenshotTabsProps) {
  const [value, setValue] = useState("0");
  if (shots.length === 0) return null;

  return (
    <Tabs value={value} onValueChange={setValue} className="block">
      {shots.map((shot, i) => (
        <TabsContent key={`${shot.tab}-${i}`} value={String(i)} className="mt-0 rounded-22 focus-visible:outline-offset-4">
          <PlaceholderScreenshot shortName={shortName} tone={tone} shots={shots} index={i} />
        </TabsContent>
      ))}
      {shots.length > 1 ? (
        <TabsList
          variant="pill"
          aria-label={PRODUCT_COPY.screenshotsLabel}
          className="mt-3.5 w-auto flex-wrap gap-2 overflow-visible rounded-none bg-transparent p-0"
        >
          {shots.map((shot, i) => (
            <TabsTrigger
              key={`${shot.tab}-${i}`}
              value={String(i)}
              className="rounded-10 border border-line bg-transparent px-3.5 py-2 text-[13.5px] leading-[normal] text-ink hover:text-ink data-[state=active]:border-primary-accent data-[state=active]:bg-surface data-[state=active]:shadow-none"
            >
              {shot.tab}
            </TabsTrigger>
          ))}
        </TabsList>
      ) : null}
    </Tabs>
  );
}
