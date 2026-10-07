"use client";

import * as React from "react";
import Link from "next/link";
import { createColumnHelper } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { csvFileName, downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { DAY_MS, formatDateIST, formatDateTimeIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { defineListState, type ListState } from "@/lib/url-state";
import { Icon, type IconName } from "@/components/icons/icon";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import {
  BulkAction,
  DataTable,
  DataTableEmptyState,
  DataTableStats,
  EmptyStateAction,
  StatTile,
  countLabel,
  matchesQuery,
  pruneSelection,
  useListState,
} from "@/components/data-table";

/* ------------------------------------------------------------------ sample data (deterministic) */

// A fixed "today", so the server render and the browser agree.
const NOW = new Date(Date.UTC(2026, 9, 7, 6, 30));

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<V>(rand: () => number, list: readonly V[]): V {
  return list[Math.floor(rand() * list.length)] as V;
}

type Tone = "sage" | "blue" | "lavender" | "peach";
const TILE: Record<Tone, string> = {
  sage: "bg-sage-bg text-sage-fg",
  blue: "bg-blue-bg text-blue-fg",
  lavender: "bg-lavender-bg text-lavender-fg",
  peach: "bg-peach-bg text-peach-fg",
};

const PRODUCTS = [
  { id: "med", name: "Medical Store Billing", code: "MED", icon: "medication", tone: "sage" },
  { id: "gst", name: "General Store GST Billing", code: "GST", icon: "storefront", tone: "blue" },
  { id: "chq", name: "Cheque Printing", code: "CHQ", icon: "edit_document", tone: "lavender" },
  { id: "rst", name: "Restaurant Billing", code: "RST", icon: "restaurant", tone: "peach" },
] as const satisfies readonly { id: string; name: string; code: string; icon: IconName; tone: Tone }[];
type Product = (typeof PRODUCTS)[number];

type LicenseStatus = "active" | "expiring" | "trial" | "expired" | "revoked";
const LICENSE_STATUS: Record<LicenseStatus, { label: string; tone: BadgeTone; rank: number }> = {
  active: { label: "Active", tone: "sage", rank: 0 },
  expiring: { label: "Expiring soon", tone: "peach", rank: 1 },
  trial: { label: "Trial", tone: "blue", rank: 2 },
  expired: { label: "Expired", tone: "peach", rank: 3 },
  revoked: { label: "Revoked", tone: "pink", rank: 4 },
};

type DemoLicense = {
  id: string;
  product: Product;
  plan: string;
  status: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
  deviceLimit: number;
  devicesUsed: number;
  keyLast4: string;
};

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeLicenses(count: number): DemoLicense[] {
  const rand = seeded(24017);
  return Array.from({ length: count }, (_, i) => {
    const product = pick(rand, PRODUCTS);
    const kind = rand();
    const trial = kind < 0.08;
    const perpetual = !trial && kind > 0.85;
    const revoked = rand() < 0.04;
    const offsetDays = Math.round(rand() * 760) - 220;
    const expiresAt = perpetual ? null : new Date(NOW.getTime() + offsetDays * DAY_MS);
    const deviceLimit = trial ? 1 : 1 + Math.floor(rand() * 5);
    let status: LicenseStatus = trial ? "trial" : "active";
    if (revoked) status = "revoked";
    else if (expiresAt && expiresAt < NOW) status = "expired";
    else if (!trial && expiresAt && offsetDays <= 60) status = "expiring";
    return {
      id: `LIC-${24017 + i}`,
      product,
      plan: trial ? "Free trial" : perpetual ? "Single computer" : pick(rand, ["Annual license", "Multi-user license"]),
      status,
      expiresAt,
      updatesUntil: new Date(NOW.getTime() + (offsetDays + (perpetual ? 120 : 0)) * DAY_MS),
      deviceLimit,
      devicesUsed: status === "revoked" ? 0 : Math.floor(rand() * (deviceLimit + 1)),
      keyLast4: Array.from({ length: 4 }, () => pick(rand, KEY_CHARS.split(""))).join(""),
    };
  });
}

const ALL_LICENSES = makeLicenses(1000);

/** The portal license page (built in Phase 5). */
function licenseHref(license: DemoLicense): string {
  return `/account/licenses/${license.id}`;
}

function maskedKey(license: DemoLicense): string {
  return `${license.product.code}-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-${license.keyLast4}`;
}

function termSub(license: DemoLicense): { text: string; warn: boolean } {
  if (!license.expiresAt) return { text: "One-time license", warn: false };
  const days = Math.round((license.expiresAt.getTime() - NOW.getTime()) / DAY_MS);
  if (days < 0) return { text: `Ended ${-days} days ago`, warn: true };
  return { text: `${days} days left`, warn: days < 60 };
}

/* ------------------------------------------------------------------ shared cells */

function Pill({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <Badge tone={tone} className="px-[9px] py-[3px] text-[12px]">
      {children}
    </Badge>
  );
}

function ProductTile({ product }: { product: Product }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-9", TILE[product.tone])}>
      <Icon name={product.icon} size={18} />
    </span>
  );
}

function LicenseName({ license }: { license: DemoLicense }) {
  return (
    <span className="flex items-center gap-2.5">
      <ProductTile product={license.product} />
      <span className="min-w-0">
        <span className="block font-extrabold">{license.product.name}</span>
        <span className="block text-[12.5px] font-semibold text-ink-2">
          {license.id} · {license.plan}
        </span>
      </span>
    </span>
  );
}

function DeviceUsage({ license }: { license: DemoLicense }) {
  const full = license.devicesUsed >= license.deviceLimit;
  return (
    <>
      <span className="block font-bold">
        {license.devicesUsed} / {license.deviceLimit}
      </span>
      <span className="mt-[5px] block h-[5px] overflow-hidden rounded-pill bg-line-subtle">
        <span
          className={cn("block h-full", full ? "bg-warn-bar" : "bg-primary")}
          style={{ width: `${Math.round((license.devicesUsed / license.deviceLimit) * 100)}%` }}
        />
      </span>
    </>
  );
}

/* ------------------------------------------------------------------ 1. portal licenses (client-side, 1,000 rows) */

const licenseCol = createColumnHelper<DemoLicense>();

const LICENSE_COLUMNS = [
  licenseCol.accessor((l) => l.product.name, {
    id: "product",
    header: "License",
    meta: { rowHeader: true },
    cell: ({ row }) => <LicenseName license={row.original} />,
  }),
  licenseCol.accessor("keyLast4", {
    id: "key",
    header: "Key",
    enableSorting: false,
    meta: { className: "whitespace-nowrap font-mono text-[12.5px] text-ink-2" },
    cell: ({ row }) => maskedKey(row.original),
  }),
  licenseCol.accessor((l) => LICENSE_STATUS[l.status].rank, {
    id: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = LICENSE_STATUS[row.original.status];
      return <Pill tone={status.tone}>{status.label}</Pill>;
    },
  }),
  licenseCol.accessor((l) => l.expiresAt?.getTime(), {
    id: "expiry",
    header: "Term",
    // Perpetual licenses (no end date) sort last in both directions.
    sortUndefined: "last",
    meta: { className: "whitespace-nowrap font-semibold" },
    cell: ({ row }) => {
      const sub = termSub(row.original);
      return (
        <>
          {row.original.expiresAt ? formatDateIST(row.original.expiresAt) : "No end date"}
          <span className={cn("block text-[12px] font-bold", sub.warn ? "text-peach-fg" : "text-ink-2")}>{sub.text}</span>
        </>
      );
    },
  }),
  licenseCol.accessor((l) => l.devicesUsed / l.deviceLimit, {
    id: "devices",
    header: "Devices",
    meta: { className: "min-w-[120px]" },
    cell: ({ row }) => <DeviceUsage license={row.original} />,
  }),
  licenseCol.accessor((l) => l.updatesUntil.getTime(), {
    id: "updates",
    header: "Updates until",
    meta: { className: "whitespace-nowrap font-semibold" },
    cell: ({ row }) => formatDateIST(row.original.updatesUntil),
  }),
  licenseCol.display({
    id: "actions",
    meta: { srLabel: "Actions", align: "right" },
    cell: ({ row }) => (
      <Link
        href={licenseHref(row.original)}
        className="inline-flex whitespace-nowrap rounded-9 border border-line-input px-3 py-1.5 text-[13px] font-bold text-ink no-underline hover:border-primary"
      >
        Manage
      </Link>
    ),
  }),
];

const LICENSE_CSV: CsvColumn<DemoLicense>[] = [
  { header: "License", value: (l) => l.id },
  { header: "Product", value: (l) => l.product.name },
  { header: "Plan", value: (l) => l.plan },
  { header: "Status", value: (l) => LICENSE_STATUS[l.status].label },
  { header: "Expires", value: (l) => (l.expiresAt ? formatDateIST(l.expiresAt) : "No end date") },
  { header: "Updates until", value: (l) => formatDateIST(l.updatesUntil) },
  { header: "Devices used", value: (l) => l.devicesUsed },
  { header: "Device limit", value: (l) => l.deviceLimit },
  { header: "Key (last 4)", value: (l) => l.keyLast4 },
];

const LICENSE_LIST = defineListState({
  filters: {
    status: { values: ["active", "expiring", "trial", "expired", "revoked"] },
    product: { values: PRODUCTS.map((p) => p.id) },
  },
  sortable: ["product", "status", "expiry", "devices", "updates"],
  defaultSort: { id: "expiry", desc: false },
  pageSize: 25,
});

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring soon" },
  { value: "trial", label: "Trial" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
];
const PRODUCT_OPTIONS = [{ value: "all", label: "All products" }, ...PRODUCTS.map((p) => ({ value: p.id, label: p.name }))];

const PAGER_STYLES = [
  { value: "prev-next", label: "Previous / Next" },
  { value: "numbered", label: "Numbered" },
] as const;

function exportLicenses(rows: readonly DemoLicense[], fileName: string) {
  downloadCsv(fileName, toCsv(rows, LICENSE_CSV));
  toast.success(`Exported ${rows.length} ${rows.length === 1 ? "row" : "rows"} to ${csvFileName(fileName)}`);
}

/** Prototype license card (below 760px). Module-level, so the 1,000 cards are not re-rendered on every change. */
function licenseCard(l: DemoLicense) {
  return (
    <>
      <span className="flex items-center gap-2.5">
        <ProductTile product={l.product} />
        <span className="min-w-0 flex-1">
          <span className="block font-extrabold">{l.product.name}</span>
          <span className="block text-[12.5px] font-semibold text-ink-2">
            {l.id} · {l.plan}
          </span>
        </span>
        <Pill tone={LICENSE_STATUS[l.status].tone}>{LICENSE_STATUS[l.status].label}</Pill>
      </span>
      <span className="flex justify-between text-[13px] font-semibold text-ink-2">
        <span>{l.expiresAt ? formatDateIST(l.expiresAt) : "No end date"}</span>
        <span>
          {l.devicesUsed} / {l.deviceLimit}
        </span>
      </span>
    </>
  );
}

function LicensesDemo() {
  const list = useListState(LICENSE_LIST, { mode: "client" });
  const { q, filters, page } = list.state;
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [paged, setPaged] = React.useState(true);
  const [pagerStyle, setPagerStyle] = React.useState<"prev-next" | "numbered">("prev-next");

  const rows = React.useMemo(
    () =>
      ALL_LICENSES.filter(
        (l) =>
          (filters.status === "all" || l.status === filters.status) &&
          (filters.product === "all" || l.product.id === filters.product) &&
          matchesQuery(q, [l.id, l.product.name, l.plan, l.keyLast4]),
      ),
    [q, filters.status, filters.product],
  );

  const selectedRows = () => {
    const ids = new Set(selected);
    return ALL_LICENSES.filter((l) => ids.has(l.id));
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => exportLicenses(rows, "licenses.csv")}>
          <Icon name="download" size={18} />
          Export CSV
        </Button>
        <label className="flex items-center gap-2 text-[14px] font-semibold text-ink-2">
          <Switch checked={paged} onCheckedChange={setPaged} />
          25 per page (off: render all {ALL_LICENSES.length.toLocaleString("en-IN")} rows)
        </label>
        <SegmentedControl
          variant="chip"
          aria-label="Pagination style"
          options={PAGER_STYLES}
          value={pagerStyle}
          onValueChange={setPagerStyle}
        />
      </div>
      <DataTable
        caption="Licenses"
        columns={LICENSE_COLUMNS}
        data={rows}
        getRowId={(l) => l.id}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={820}
        rowHref={licenseHref}
        toolbar={{
          search: {
            value: q,
            onChange: list.setQuery,
            placeholder: "License ID, product or last 4 of key",
            label: "Search licenses",
          },
          filters: [
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: filters.status, onChange: (v) => list.setFilter("status", v) },
            { id: "product", label: "Product", options: PRODUCT_OPTIONS, value: filters.product, onChange: (v) => list.setFilter("product", v) },
          ],
        }}
        selection={{
          selected,
          onChange: setSelected,
          bulkActions: (
            <>
              <BulkAction
                tone="primary"
                onClick={() => {
                  const chosen = selectedRows();
                  const skipped = chosen.some((l) => l.status === "revoked");
                  toast.success(`${chosen.filter((l) => l.status !== "revoked").length} renewals added to the cart (demo)`);
                  if (skipped) toast("Revoked licenses were skipped");
                }}
              >
                Renew selected
              </BulkAction>
              <BulkAction onClick={() => exportLicenses(selectedRows(), "licenses-selected.csv")}>Export selected</BulkAction>
            </>
          ),
        }}
        pagination={
          paged
            ? { page, pageSize: 25, onPageChange: list.setPage, pageHref: list.pageHref, style: pagerStyle, label: "Licenses pages" }
            : undefined
        }
        footer={
          paged ? undefined : `${rows.length} of ${ALL_LICENSES.length} licenses · keys are masked; open a license to reveal`
        }
        emptyState={
          <DataTableEmptyState action={<EmptyStateAction clearsFilters onClick={list.clear}>Clear filters</EmptyStateAction>}>
            No licenses match these filters.
          </DataTableEmptyState>
        }
        mobileCard={licenseCard}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ 2. portal devices (local state, default cards) */

type DeviceStatus = "active" | "stale" | "deactivated";
const DEVICE_STATUS: Record<DeviceStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "sage" },
  stale: { label: "Inactive 30d+", tone: "peach" },
  deactivated: { label: "Deactivated", tone: "slate" },
};
const LOCATIONS = [
  { id: "loc1", name: "Main counter" },
  { id: "loc2", name: "Pune branch" },
  { id: "none", name: "Unassigned" },
] as const;

type DemoDevice = {
  id: string;
  name: string;
  os: string;
  icon: IconName;
  license: DemoLicense;
  locationId: string;
  activatedAt: Date;
  lastSeenAt: Date;
  status: DeviceStatus;
};

function makeDevices(count: number): DemoDevice[] {
  const rand = seeded(860);
  const names = ["Billing counter PC", "Owner laptop", "Store tablet", "Back office desktop", "Pharmacy till", "Kitchen display"];
  return Array.from({ length: count }, (_, i) => {
    const license = ALL_LICENSES[i % 30] as DemoLicense;
    const icon = pick(rand, ["desktop_windows", "laptop", "smartphone"] as const);
    const seenDaysAgo = rand() < 0.2 ? 31 + Math.floor(rand() * 60) : rand() * 6;
    const deactivated = rand() < 0.15;
    return {
      id: `dev-${i + 1}`,
      name: `${pick(rand, names)} ${i + 1}`,
      os: icon === "smartphone" ? "Android 14" : pick(rand, ["Windows 11", "Windows 10", "Ubuntu 24.04"]),
      icon,
      license,
      locationId: pick(rand, ["loc1", "loc2", "none"]),
      activatedAt: new Date(NOW.getTime() - (40 + Math.floor(rand() * 400)) * DAY_MS),
      lastSeenAt: new Date(NOW.getTime() - seenDaysAgo * DAY_MS),
      status: deactivated ? "deactivated" : seenDaysAgo > 30 ? "stale" : "active",
    };
  });
}

function relativeTime(date: Date): string {
  const hours = Math.floor((NOW.getTime() - date.getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return days < 45 ? `${days}d ago` : formatDateIST(date);
}

const deviceCol = createColumnHelper<DemoDevice>();

function deviceColumns(actions: { move: (id: string, locationId: string) => void; deactivate: (ids: string[]) => void }) {
  return [
    deviceCol.accessor("name", {
      header: "Device",
      enableSorting: false,
      meta: { rowHeader: true },
      cell: ({ row }) => (
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-9 bg-slate-bg text-ink-2">
            <Icon name={row.original.icon} size={18} />
          </span>
          <span className="min-w-0 text-left">
            <span className="block font-extrabold">{row.original.name}</span>
            <span className="block text-[12px] font-semibold text-ink-2">{row.original.os}</span>
          </span>
        </span>
      ),
    }),
    deviceCol.accessor((d) => d.license.id, {
      id: "license",
      header: "License",
      enableSorting: false,
      cell: ({ row }) => (
        <>
          <Link href={licenseHref(row.original.license)} className="font-bold text-primary-link no-underline hover:underline">
            {row.original.license.id}
          </Link>
          <span className="block text-[12px] font-semibold text-ink-2">{row.original.license.product.name}</span>
        </>
      ),
    }),
    deviceCol.accessor("locationId", {
      header: "Location",
      enableSorting: false,
      cell: ({ row }) => (
        <select
          aria-label={`Location for ${row.original.name}`}
          value={row.original.locationId}
          disabled={row.original.status === "deactivated"}
          onChange={(event) => actions.move(row.original.id, event.target.value)}
          className="field-focus h-[34px] max-w-full cursor-pointer rounded-8 border border-line-strong bg-surface px-1.5 text-[13px] font-semibold text-ink disabled:cursor-not-allowed disabled:bg-line-subtle"
        >
          {LOCATIONS.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      ),
    }),
    deviceCol.accessor((d) => d.activatedAt.getTime(), {
      id: "activated",
      header: "Activated",
      meta: { className: "whitespace-nowrap font-semibold" },
      cell: ({ row }) => formatDateIST(row.original.activatedAt),
    }),
    deviceCol.accessor((d) => d.lastSeenAt.getTime(), {
      id: "lastSeen",
      header: "Last seen",
      sortDescFirst: true,
      cell: ({ row }) => (
        <span className={cn("whitespace-nowrap font-semibold", row.original.status === "stale" && "text-peach-fg")}>
          {relativeTime(row.original.lastSeenAt)}
        </span>
      ),
    }),
    deviceCol.accessor("status", {
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => <Pill tone={DEVICE_STATUS[row.original.status].tone}>{DEVICE_STATUS[row.original.status].label}</Pill>,
    }),
    deviceCol.display({
      id: "actions",
      meta: { srLabel: "Actions", align: "right" },
      cell: ({ row }) =>
        row.original.status === "deactivated" ? null : (
          <Button
            type="button"
            variant="destructive-outline"
            size="sm"
            className="rounded-9 px-3 py-1.5 text-[13px]"
            onClick={() => actions.deactivate([row.original.id])}
          >
            Deactivate
          </Button>
        ),
    }),
  ];
}

const INITIAL_DEVICES = makeDevices(60).sort(
  (a, b) =>
    Number(a.status === "deactivated") - Number(b.status === "deactivated") ||
    b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
);

type DeviceTab = "active" | "stale" | "deactivated" | "all";
const DEVICE_TABS = [
  { value: "active", label: "Active" },
  { value: "stale", label: "Inactive 30d+" },
  { value: "deactivated", label: "Deactivated" },
  { value: "all", label: "All" },
] as const satisfies readonly { value: DeviceTab; label: string }[];

function DevicesDemo() {
  const [devices, setDevices] = React.useState(INITIAL_DEVICES);
  const [q, setQ] = React.useState("");
  const [tab, setTab] = React.useState<DeviceTab>("active");
  const [location, setLocation] = React.useState("all");
  const [selected, setSelected] = React.useState<readonly string[]>([]);

  const move = React.useCallback((id: string, locationId: string) => {
    setDevices((current) => current.map((d) => (d.id === id ? { ...d, locationId } : d)));
    const device = INITIAL_DEVICES.find((d) => d.id === id);
    const name = LOCATIONS.find((l) => l.id === locationId)?.name ?? "Unassigned";
    if (device) toast.success(`${device.name} moved to ${name}`);
  }, []);
  const deactivate = React.useCallback((ids: string[]) => {
    setDevices((current) => current.map((d) => (ids.includes(d.id) ? { ...d, status: "deactivated" as const } : d)));
    setSelected((current) => current.filter((id) => !ids.includes(id)));
    toast.success(ids.length === 1 ? "Device deactivated · 1 slot free" : `${ids.length} devices deactivated`);
  }, []);
  const columns = React.useMemo(() => deviceColumns({ move, deactivate }), [move, deactivate]);

  const rows = React.useMemo(
    () =>
      devices.filter(
        (d) =>
          (tab === "all" ||
            (tab === "active" ? d.status !== "deactivated" : d.status === tab)) &&
          (location === "all" || d.locationId === location) &&
          matchesQuery(q, [d.name, d.os, d.license.id, d.license.product.name]),
      ),
    [devices, tab, location, q],
  );
  const visibleSelected = React.useMemo(() => pruneSelection(selected, rows.map((d) => d.id)), [selected, rows]);

  const live = devices.filter((d) => d.status !== "deactivated");
  const stale = devices.filter((d) => d.status === "stale").length;

  return (
    <DataTable
      caption="Devices"
      columns={columns}
      data={rows}
      getRowId={(d) => d.id}
      getRowLabel={(d) => d.name}
      defaultSorting={[]}
      minWidth={860}
      stats={
        <DataTableStats aria-label="Device summary">
          <StatTile label="Active devices" value={live.length} />
          <StatTile label="Free slots" value={Math.max(0, 74 - live.length)} tone="sage" />
          <StatTile label="Inactive 30 days+" value={stale} tone={stale > 0 ? "peach" : "default"} />
          <StatTile label="Locations" value={2} />
        </DataTableStats>
      }
      toolbar={{
        search: { value: q, onChange: setQ, placeholder: "Device name, OS or license", label: "Search devices" },
        controls: (
          <SegmentedControl variant="chip" aria-label="Status" options={DEVICE_TABS} value={tab} onValueChange={setTab} />
        ),
        filters: [
          {
            id: "location",
            label: "Location",
            options: [{ value: "all", label: "All locations" }, ...LOCATIONS.map((l) => ({ value: l.id, label: l.name }))],
            value: location,
            onChange: setLocation,
          },
        ],
      }}
      selection={{
        selected: visibleSelected,
        onChange: setSelected,
        isRowSelectable: (d) => d.status !== "deactivated",
        selectAllLabel: "Select all active devices",
        bulkActions: (
          <>
            <BulkAction tone="danger" onClick={() => deactivate([...visibleSelected])}>
              Deactivate selected
            </BulkAction>
            <BulkAction onClick={() => toast.success(`Exported ${visibleSelected.length} rows to devices.csv (demo)`)}>
              Export selected
            </BulkAction>
          </>
        ),
      }}
      footer={`${rows.length} devices shown · fingerprints are hashed on the device; we never collect files or billing data`}
      emptyState="No devices match these filters."
    />
  );
}

/* ------------------------------------------------------------------ 3. admin generic table (server-style paging) */

type OrderStatus = "paid" | "pending" | "failed" | "refunded" | "canceled";
const ORDER_STATUS: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  paid: { label: "Paid", tone: "sage" },
  pending: { label: "Pending", tone: "peach" },
  failed: { label: "Failed", tone: "pink" },
  refunded: { label: "Refunded", tone: "lavender" },
  canceled: { label: "Canceled", tone: "slate" },
};
const METHODS = { upi: "UPI", card: "Card", netbanking: "Net banking" } as const;
type Method = keyof typeof METHODS;

type DemoOrder = {
  id: string;
  invoice: string | null;
  createdAt: Date;
  customer: string;
  email: string;
  items: string;
  status: OrderStatus;
  method: Method;
  total: number;
  tax: "IGST" | "CGST+SGST";
};

function makeOrders(count: number): DemoOrder[] {
  const rand = seeded(10262);
  const customers = [
    ["Spice Route Kitchen", "arjun@spiceroutekitchen.example"],
    ["Iyer Pharmacy", "meera@iyerpharmacy.example"],
    ["City Chemists", "imran@citychemists.example"],
    ["Patel Kirana", "sanjay@patelkirana.example"],
    ["Gupta Accounts Office", "vivek@guptaaccountsoffice.example"],
    ["Sharma Medicals", "priya@sharmamedicals.example"],
  ] as const;
  const totals = [412882, 943882, 353882, 2359882, 1533882, 164964];
  return Array.from({ length: count }, (_, i) => {
    const [customer, email] = pick(rand, customers);
    const status = pick(rand, ["paid", "paid", "paid", "paid", "pending", "failed", "refunded", "canceled"] as const);
    const createdAt = new Date(NOW.getTime() - Math.floor(rand() * 200 * 24) * 3_600_000);
    const product = pick(rand, PRODUCTS);
    return {
      id: `AX-${10340 - i}`,
      invoice: status === "paid" || status === "refunded" ? `AXS/26-27/${String(1000 + count - i).padStart(4, "0")}` : null,
      createdAt,
      customer,
      email,
      items: `${product.name} · ${pick(rand, ["Annual license", "One-time license", "Multi-user license"])}`,
      status,
      method: pick(rand, ["upi", "upi", "card", "netbanking"] as const),
      total: pick(rand, totals),
      tax: customer === "Sharma Medicals" ? "CGST+SGST" : "IGST",
    };
  });
}

const ALL_ORDERS = makeOrders(67);

const ADMIN_LIST = defineListState({
  filters: {
    status: { values: ["paid", "pending", "failed", "refunded", "canceled"] },
    method: { values: ["upi", "card", "netbanking"] },
  },
  filterStyle: "bracket",
  sortable: ["date", "status", "total"],
  defaultSort: { id: "date", desc: true },
  pageSize: 10,
  params: { q: "aq", sort: "asort", page: "apage" },
});
type AdminState = ListState<"status" | "method">;

/** What a GET /api/admin/orders?filter[status]=&sort=-date&page= handler would do. */
function filterOrders(all: readonly DemoOrder[], state: AdminState): DemoOrder[] {
  const rows = all.filter(
    (o) =>
      (state.filters.status === "all" || o.status === state.filters.status) &&
      (state.filters.method === "all" || o.method === state.filters.method),
  );
  const sort = state.sort ?? { id: "date", desc: true };
  const value = (o: DemoOrder) => (sort.id === "total" ? o.total : sort.id === "status" ? o.status : o.createdAt.getTime());
  return rows.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return (x > y ? 1 : x < y ? -1 : 0) * (sort.desc ? -1 : 1);
  });
}

const orderCol = createColumnHelper<DemoOrder>();
const sub = "mt-px block text-[11.5px] font-semibold text-ink-2";

const ORDER_COLUMNS = [
  orderCol.accessor("id", {
    header: "Order",
    enableSorting: false,
    meta: { rowHeader: true },
    cell: ({ row }) => (
      <>
        <span className="block font-mono text-[12px] font-extrabold">{row.original.id}</span>
        {row.original.invoice ? <span className={cn(sub, "font-mono")}>{row.original.invoice}</span> : null}
      </>
    ),
  }),
  orderCol.accessor((o) => o.createdAt.getTime(), {
    id: "date",
    header: "Date",
    enableSorting: true,
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-semibold">
        {formatDateIST(row.original.createdAt)}
        <span className={sub}>{formatDateTimeIST(row.original.createdAt).split(", ")[1]}</span>
      </span>
    ),
  }),
  orderCol.accessor("customer", {
    header: "Customer",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-semibold">
        {row.original.customer}
        <span className={sub}>{row.original.email}</span>
      </span>
    ),
  }),
  orderCol.accessor("items", { header: "Items", enableSorting: false, meta: { className: "min-w-[180px] font-semibold" } }),
  orderCol.accessor("status", {
    header: "Status",
    enableSorting: true,
    cell: ({ row }) => <Pill tone={ORDER_STATUS[row.original.status].tone}>{ORDER_STATUS[row.original.status].label}</Pill>,
  }),
  orderCol.accessor((o) => METHODS[o.method], { id: "method", header: "Method", enableSorting: false, meta: { className: "font-semibold" } }),
  orderCol.accessor("total", {
    header: "Total",
    enableSorting: true,
    meta: { align: "right", className: "whitespace-nowrap" },
    cell: ({ row }) => (
      <span className="font-extrabold">
        {formatINR(row.original.total)}
        <span className={sub}>{row.original.tax}</span>
      </span>
    ),
  }),
];

const ORDER_CSV: CsvColumn<DemoOrder>[] = [
  { header: "Order", value: (o) => o.id },
  { header: "Date", value: (o) => formatDateIST(o.createdAt) },
  { header: "Email", value: (o) => o.email },
  { header: "Status", value: (o) => ORDER_STATUS[o.status].label },
  { header: "Total", value: (o) => (o.total / 100).toFixed(2) },
];

/** Admin card (phrasing content only: the whole card is the row button). */
function orderCard(o: DemoOrder) {
  return (
    <>
      <span className="flex items-center justify-between gap-2.5">
        <span className="text-[14px] font-extrabold">{o.id}</span>
        <Pill tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Pill>
      </span>
      <span className="text-[12.5px] font-semibold text-ink-2">
        {o.customer} · {formatINR(o.total)} · {formatDateIST(o.createdAt)}
      </span>
    </>
  );
}

function DemoSwitch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[14px] font-semibold text-ink-2">
      <Switch checked={checked} onCheckedChange={onChange} />
      {children}
    </label>
  );
}

const ORDER_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  ...Object.entries(ORDER_STATUS).map(([value, s]) => ({ value, label: s.label })),
];
const METHOD_OPTIONS = [{ value: "all", label: "All" }, ...Object.entries(METHODS).map(([value, label]) => ({ value, label }))];

function AdminOrdersDemo() {
  const list = useListState(ADMIN_LIST, { mode: "client" });
  const applied = list.applied;
  const [slow, setSlow] = React.useState(false);
  const [fail, setFail] = React.useState(false);
  const [empty, setEmpty] = React.useState(false);
  const [viewer, setViewer] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [result, setResult] = React.useState<{ items: DemoOrder[]; total: number } | null>(null);
  const [error, setError] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  // Simulated fetch of one page whenever the URL state changes.
  React.useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        setLoading(false);
        if (fail) {
          setError(true);
          return;
        }
        const rows = filterOrders(empty ? [] : ALL_ORDERS, applied);
        const start = (applied.page - 1) * applied.pageSize;
        setError(false);
        setResult({ items: rows.slice(start, start + applied.pageSize), total: rows.length });
      },
      slow ? 1500 : 350,
    );
    return () => window.clearTimeout(timer);
  }, [applied, fail, empty, slow, attempt]);

  const total = result?.total ?? 0;
  const paid = ALL_ORDERS.filter((o) => o.status === "paid").length;
  const refunded = ALL_ORDERS.filter((o) => o.status === "refunded").reduce((sum, o) => sum + o.total, 0);
  const locked = viewer ? "Not allowed for your role" : undefined;

  const exportAll = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    const rows = filterOrders(ALL_ORDERS, applied);
    downloadCsv("orders.csv", toCsv(rows, ORDER_CSV));
    toast.success(`Exported ${rows.length} rows to orders.csv`);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <DemoSwitch checked={slow} onChange={setSlow}>
          Slow network
        </DemoSwitch>
        <DemoSwitch checked={fail} onChange={setFail}>
          Fail requests
        </DemoSwitch>
        <DemoSwitch checked={empty} onChange={setEmpty}>
          No orders
        </DemoSwitch>
        <DemoSwitch checked={viewer} onChange={setViewer}>
          Viewer role (locked actions)
        </DemoSwitch>
      </div>
      <div className="rounded-16 bg-bg-admin p-3 sm:p-4">
        <DataTable
          variant="admin"
          caption="Orders"
          columns={ORDER_COLUMNS}
          data={result?.items ?? []}
          getRowId={(o) => o.id}
          sorting={list.sorting}
          onSortingChange={list.onSortingChange}
          minWidth={900}
          loading={loading}
          stats={
            <DataTableStats variant="admin" aria-label="Order summary">
              <StatTile variant="admin" label="Paid (all time)" value={paid} tone="sage" />
              <StatTile variant="admin" label="Pending" value={ALL_ORDERS.filter((o) => o.status === "pending").length} tone="peach" />
              <StatTile variant="admin" label="Failed" value={ALL_ORDERS.filter((o) => o.status === "failed").length} tone="pink" />
              <StatTile variant="admin" label="Refunded" value={formatINR(refunded)} tone="lavender" />
            </DataTableStats>
          }
          toolbar={{
            filters: [
              { id: "status", label: "Status", options: ORDER_STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => list.setFilter("status", v) },
              { id: "method", label: "Method", options: METHOD_OPTIONS, value: list.state.filters.method, onChange: (v) => list.setFilter("method", v) },
            ],
            onClear: list.clear,
            countLabel: result ? countLabel(total) : undefined,
            csv: { fileName: "orders.csv", disabledReason: viewer ? "Export needs Owner or Finance" : undefined, onExport: exportAll },
          }}
          selection={{
            selected,
            onChange: setSelected,
            selectAllLabel: "Select all on this page",
            clearLabel: "Clear selection",
            bulkActions: (
              <>
                <BulkAction variant="admin" disabledReason={locked} onClick={() => toast.success(`${selected.length} invoice emails queued (demo)`)}>
                  Resend invoices
                </BulkAction>
                <BulkAction variant="admin" onClick={() => toast.success(`Exported ${selected.length} rows to orders-selected.csv (demo)`)}>
                  Export selected
                </BulkAction>
              </>
            ),
          }}
          pagination={{
            page: applied.page,
            pageSize: applied.pageSize,
            total,
            onPageChange: list.setPage,
            pageHref: list.pageHref,
            style: "compact",
            label: "Orders pages",
            emptyLabel: "0 records",
          }}
          onRowClick={(o) => toast(`Opened ${o.id}. The order drawer arrives in Phase 6.`)}
          errorState={
            error ? (
              <DataTableEmptyState
                variant="admin"
                tone="error"
                icon="error"
                action={<EmptyStateAction onClick={() => setAttempt((n) => n + 1)}>Try again</EmptyStateAction>}
              >
                Couldn&rsquo;t load orders.
              </DataTableEmptyState>
            ) : undefined
          }
          mobileCard={orderCard}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ gallery section */

export function DataTableDemos() {
  return (
    <div className="grid gap-12">
      <div className="grid gap-3">
        <h3 className="text-[17px] font-extrabold">Portal: licenses (client-side, 1,000 rows, URL state)</h3>
        <p className="max-w-[760px] text-[14.5px] text-ink-2">
          Search, filters, sort and page live in the URL (?q=&amp;status=&amp;product=&amp;sort=&amp;page=). Rows link to
          the license; select rows for the bulk bar. Below 760px the rows become cards.
        </p>
        <LicensesDemo />
      </div>
      <div className="grid gap-3">
        <h3 className="text-[17px] font-extrabold">Portal: devices (stats row, segmented filter, default cards)</h3>
        <p className="max-w-[760px] text-[14.5px] text-ink-2">
          Deactivated devices have no checkbox; inline location selects and Deactivate buttons work inside rows and in
          the cards built from the columns.
        </p>
        <DevicesDemo />
      </div>
      <div className="grid gap-3">
        <h3 className="text-[17px] font-extrabold">Admin: generic table (server-side paging, row click)</h3>
        <p className="max-w-[760px] text-[14.5px] text-ink-2">
          Filters use ?filter[status]=; the table shows one page and the total. A row click (or its Open button) opens
          the record; toggle slow, failing and empty responses and a role without export rights.
        </p>
        <AdminOrdersDemo />
      </div>
    </div>
  );
}
