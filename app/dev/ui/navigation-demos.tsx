"use client";

import * as React from "react";
import { formatINR } from "@/lib/money";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
  type SortDirection,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Demo, DemoGrid } from "@/app/dev/ui/section";
import { LICENSE_STATES, type LicenseStateKey } from "@/app/dev/ui/license-states";

type Row = { id: string; product: string; state: LicenseStateKey; expires: string; amount: number };

const ROWS: readonly Row[] = [
  { id: "LIC-24017", product: "Medical Store Billing", state: "active", expires: "2027-09-12", amount: 299_900 },
  { id: "LIC-24009", product: "Restaurant Billing", state: "expiring", expires: "2026-11-02", amount: 449_900 },
  { id: "LIC-23981", product: "General Store GST Billing", state: "trial", expires: "2026-10-20", amount: 0 },
  { id: "LIC-23877", product: "Cheque Printing", state: "expired", expires: "2026-08-30", amount: 149_900 },
  { id: "LIC-23802", product: "Medical Store Billing", state: "suspended", expires: "2027-01-15", amount: 299_900 },
];

type SortKey = "id" | "expires" | "amount";

const FAQS = [
  ["Can I import my existing medicine list?", "Yes. Import items from an Excel or CSV file during setup, including batch and expiry details."],
  ["Does it work without internet?", "Yes. Internet is needed only to activate the license and download updates."],
  [
    "What happens when an annual license ends?",
    "Your data stays on your computer. Creating new bills needs an active license, so renew before the end date to avoid interruption.",
  ],
] as const;

/** Tabs, FAQ accordion and a sortable table with aria-sort. */
export function NavigationDemos() {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "expires", dir: 1 });

  const rows = [...ROWS].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  });
  const direction = (key: SortKey): SortDirection =>
    sort.key !== key ? "none" : sort.dir === 1 ? "ascending" : "descending";
  const toggle = (key: SortKey) =>
    setSort((current) => ({ key, dir: current.key === key ? (current.dir === 1 ? -1 : 1) : 1 }));

  return (
    <div className="grid gap-4">
      <DemoGrid>
        <Demo title="Tabs (underline)">
          <Tabs defaultValue="overview">
            <TabsList aria-label="License detail">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="downloads">Downloads</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="text-[14.5px] text-ink-body">
              Arrow keys move between tabs; Tab moves into the panel.
            </TabsContent>
            <TabsContent value="devices" className="text-[14.5px] text-ink-body">
              2 of 3 devices active.
            </TabsContent>
            <TabsContent value="history" className="text-[14.5px] text-ink-body">
              Issued 12 Sep 2026.
            </TabsContent>
            <TabsContent value="downloads" className="text-[14.5px] text-ink-body">
              Version 4.2.1 · 148 MB
            </TabsContent>
          </Tabs>
        </Demo>
        <Demo title="Tabs (pill)">
          <Tabs defaultValue="windows">
            <TabsList variant="pill" aria-label="Operating system">
              <TabsTrigger value="windows">Windows</TabsTrigger>
              <TabsTrigger value="macos">macOS</TabsTrigger>
              <TabsTrigger value="android">Android</TabsTrigger>
            </TabsList>
            <TabsContent value="windows" className="text-[14.5px] text-ink-body">
              Windows 10 or 11 (64-bit)
            </TabsContent>
            <TabsContent value="macos" className="text-[14.5px] text-ink-body">
              macOS 13 or later
            </TabsContent>
            <TabsContent value="android" className="text-[14.5px] text-ink-body">
              Android 10 or later
            </TabsContent>
          </Tabs>
        </Demo>
      </DemoGrid>

      <Demo title="Accordion (FAQ, single open, first open)">
        <Accordion type="single" collapsible defaultValue="faq-0" className="max-w-[880px]">
          {FAQS.map(([question, answer], index) => (
            <AccordionItem key={question} value={`faq-${index}`}>
              <AccordionTrigger>{question}</AccordionTrigger>
              <AccordionContent>{answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Demo>

      <Demo title="Table with sortable headers (aria-sort)">
        <Table className="min-w-[620px]" wrapperClassName="rounded-12 border border-line">
          <TableCaption>Sample licenses. Click a header to sort; the header cell carries aria-sort.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableSortHead sort={direction("id")} onSort={() => toggle("id")}>
                License
              </TableSortHead>
              <TableHead>Product</TableHead>
              <TableHead>Status</TableHead>
              <TableSortHead sort={direction("expires")} onSort={() => toggle("expires")}>
                Expires
              </TableSortHead>
              <TableSortHead sort={direction("amount")} onSort={() => toggle("amount")} align="right">
                Amount
              </TableSortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const state = LICENSE_STATES[row.state];
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-[13px]">{row.id}</TableCell>
                  <TableCell className="font-semibold">{row.product}</TableCell>
                  <TableCell>
                    <StatusPill tone={state.tone} icon={state.icon} label={state.label} size="sm" />
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">{row.expires}</TableCell>
                  <TableCell className="tabular text-right">{formatINR(row.amount)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Demo>
    </div>
  );
}
