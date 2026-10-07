"use client";

import type * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type OsTabPanel = {
  value: string;
  label: string;
  /** Server-rendered panel content (the step list for that operating system). */
  content: React.ReactNode;
};

export type OsTabsProps = {
  panels: readonly OsTabPanel[];
  /** Selected first (Windows, as in the prototype). */
  defaultValue: string;
};

/**
 * "Operating system" tabs of the install guide: real tabs (tablist, arrow keys, tabpanels), styled as the prototype's
 * pill switch (slate track, white selected chip, 14px/700).
 */
export function OsTabs({ panels, defaultValue }: OsTabsProps) {
  return (
    <Tabs defaultValue={defaultValue} className="mt-[18px] block">
      <TabsList variant="pill" aria-label="Operating system" className="gap-0">
        {panels.map((panel) => (
          <TabsTrigger
            key={panel.value}
            value={panel.value}
            className="px-3.5 py-2 text-[14px] leading-[normal] text-ink hover:text-ink"
          >
            {panel.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((panel) => (
        <TabsContent key={panel.value} value={panel.value} className="mt-[22px]">
          {panel.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
