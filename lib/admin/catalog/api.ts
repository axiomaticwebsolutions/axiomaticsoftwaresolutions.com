/**
 * Request parsing and CSV columns of the /api/admin catalog routes (products, plans, releases): the list query specs
 * (q, filter[...], sort, page, pageSize; lenient like the pages' URL state) and the export columns. Server-only.
 */
import "server-only";
import type { CsvColumn } from "@/lib/csv";
import { parseListQuery } from "@/lib/admin/list-query";
import { istParts } from "@/lib/dates";
import { paiseToDecimalString } from "@/lib/money";
import {
  PLAN_DEFAULT_SORT,
  PLAN_SORTS,
  PLAN_STATUS_FILTERS,
  PRODUCT_DEFAULT_SORT,
  PRODUCT_SORTS,
  PRODUCT_STATUS_FILTERS,
  RELEASE_DEFAULT_SORT,
  RELEASE_SORTS,
} from "./list-config";
import {
  PLAN_TYPE_FILTERS,
  PLAN_TYPE_LABELS,
  planDeviceLimitLabel,
  planTermLabel,
  planUpdatesLabel,
  platformList,
  RELEASE_STATUS_FILTERS,
  releaseChannelLabel,
} from "./model";
import { SLUG_RE } from "./schemas";
import type { PlanListQuery } from "./plans";
import type { ProductListQuery } from "./products";
import type { ReleaseListQuery } from "./releases";
import type { AdminPlanRow, AdminProductRow, AdminReleaseRow } from "./types";

/** A slug-shaped filter value (product or category id), else ignored. */
function slugFilter(raw: string): string | undefined {
  return raw.length <= 60 && SLUG_RE.test(raw) ? raw : undefined;
}

export function productListQuery(input: Request | URL | URLSearchParams | string): ProductListQuery {
  return parseListQuery(input, {
    filters: { category: slugFilter, status: PRODUCT_STATUS_FILTERS },
    sortable: PRODUCT_SORTS,
    defaultSort: PRODUCT_DEFAULT_SORT,
  });
}

export function planListQuery(input: Request | URL | URLSearchParams | string): PlanListQuery {
  return parseListQuery(input, {
    filters: { product: slugFilter, type: PLAN_TYPE_FILTERS, status: PLAN_STATUS_FILTERS },
    sortable: PLAN_SORTS,
    defaultSort: PLAN_DEFAULT_SORT,
  });
}

export function releaseListQuery(input: Request | URL | URLSearchParams | string): ReleaseListQuery {
  return parseListQuery(input, {
    filters: { product: slugFilter, status: RELEASE_STATUS_FILTERS },
    sortable: RELEASE_SORTS,
    defaultSort: RELEASE_DEFAULT_SORT,
  });
}

/** "2026-09-14" (the IST calendar date) for CSV cells. */
export function istDate(iso: string | null): string {
  if (!iso) return "";
  const p = istParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "medical-billing" filters etc. as audit detail: "status: published · category: pharmacy · search: med". */
export function filtersDetail(query: { q: string; filters: Record<string, string | undefined> }): string | null {
  const parts = Object.entries(query.filters)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  if (query.q) parts.push(`search: ${query.q}`);
  return parts.length > 0 ? parts.join(" \u00B7 ") : null;
}

const STATUS_WORDS: Record<string, string> = { PUBLISHED: "Published", HIDDEN: "Hidden", DRAFT: "Draft" };

export const PRODUCT_CSV_COLUMNS: readonly CsvColumn<AdminProductRow>[] = [
  { header: "Product", value: (r) => r.name },
  { header: "Display name", value: (r) => r.shortName },
  { header: "License prefix", value: (r) => r.code },
  { header: "Product id", value: (r) => r.id },
  { header: "Category", value: (r) => r.categoryName },
  { header: "Platforms", value: (r) => platformList(r.platforms) },
  { header: "Latest version", value: (r) => r.latest?.version ?? "" },
  { header: "Latest release date", value: (r) => istDate(r.latest?.releasedAt ?? null) },
  { header: "Plans on sale", value: (r) => r.planCount },
  { header: "From (INR, excl. GST)", value: (r) => (r.fromPricePaise === null ? "" : paiseToDecimalString(r.fromPricePaise)) },
  { header: "Status", value: (r) => STATUS_WORDS[r.status] ?? r.status },
  { header: "Rank", value: (r) => r.rank },
];

export const PLAN_CSV_COLUMNS: readonly CsvColumn<AdminPlanRow>[] = [
  { header: "Plan", value: (r) => r.name },
  { header: "Plan id", value: (r) => r.id },
  { header: "Product", value: (r) => r.productName },
  { header: "Type", value: (r) => (r.multiDevice ? `${PLAN_TYPE_LABELS[r.type]} (multi-device)` : PLAN_TYPE_LABELS[r.type]) },
  { header: "Price (INR, excl. GST)", value: (r) => paiseToDecimalString(r.pricePaise) },
  { header: "Term", value: (r) => planTermLabel(r) },
  { header: "Device limit", value: (r) => planDeviceLimitLabel(r) },
  { header: "Updates", value: (r) => planUpdatesLabel(r) },
  { header: "Status", value: (r) => (r.archived ? "Archived" : "On sale") },
];

const RELEASE_STATUS_WORDS: Record<string, string> = { latest: "Latest", published: "Published", draft: "Draft", withdrawn: "Withdrawn" };

export const RELEASE_CSV_COLUMNS: readonly CsvColumn<AdminReleaseRow>[] = [
  { header: "Product", value: (r) => r.productName },
  { header: "Version", value: (r) => r.version },
  { header: "Channel", value: (r) => releaseChannelLabel(r.channel) },
  { header: "Status", value: (r) => RELEASE_STATUS_WORDS[r.status] ?? r.status },
  { header: "Release date", value: (r) => istDate(r.releasedAt) },
  { header: "Installers", value: (r) => platformList(r.platforms) },
  { header: "Installer size (bytes)", value: (r) => r.installerBytes ?? "" },
  { header: "First note", value: (r) => r.firstNote ?? "" },
];
