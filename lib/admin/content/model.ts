/**
 * Admin Content & FAQs (Admin Console.dc.html #content; decisions.md Phase 6): FAQ pages, the FAQ DTO, the list URL
 * contract shared by the page, the client table and GET /api/admin/faqs, the site banner and sample notice copy.
 * Pure and client-safe.
 *
 * FAQ pages are "home", "pricing", "support" or a product id (Faq.page = product slug, decisions.md "Other
 * assumptions"). Within a page FAQs show by sortOrder; new FAQs go to the end of their page.
 */
import type { ListQuerySpec } from "@/lib/admin/list-query";
import { defineListState } from "@/lib/url-state";

export const FAQ_FIXED_PAGES = ["home", "pricing", "support"] as const;
export type FaqFixedPage = (typeof FAQ_FIXED_PAGES)[number];

export const FAQ_FIXED_PAGE_LABELS: Readonly<Record<FaqFixedPage, string>> = { home: "Home", pricing: "Pricing", support: "Support" };

/** A page FAQs can live on: the three fixed pages, then every product by rank. */
export type FaqPageOption = { value: string; label: string; kind: "page" | "product" };

export function isFixedFaqPage(page: string): page is FaqFixedPage {
  return (FAQ_FIXED_PAGES as readonly string[]).includes(page);
}

/** The fixed pages followed by the products (id + short name, in catalog order). */
export function faqPageOptions(products: readonly { id: string; name: string }[]): FaqPageOption[] {
  return [
    ...FAQ_FIXED_PAGES.map((p) => ({ value: p, label: FAQ_FIXED_PAGE_LABELS[p], kind: "page" as const })),
    ...products.map((p) => ({ value: p.id, label: p.name, kind: "product" as const })),
  ];
}

/** "Home", "Pricing", "Medical Store Billing"; an unknown page reads as stored. */
export function faqPageLabel(page: string, options: readonly FaqPageOption[]): string {
  return options.find((o) => o.value === page)?.label ?? page;
}

export const FAQ_STATUSES = ["published", "draft"] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];

export type FaqDto = {
  id: string;
  page: string;
  pageLabel: string;
  question: string;
  answer: string;
  /** Optional "Read the guide" link on this site (support FAQs), e.g. /docs/activation. */
  href: string | null;
  published: boolean;
  status: FaqStatus;
  sortOrder: number;
  /** 1-based place on its page and the number of FAQs there. */
  position: number;
  pageCount: number;
};

/** Prototype QUESTION cell: the answer cut to 90 characters with an ellipsis. */
export function faqExcerpt(answer: string, max = 90): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}

// ---------- List URL contract (?q=&filter[page]=&filter[status]=&sort=&page=) ----------

export const FAQ_SORTS = ["order", "question", "page"] as const;
export type FaqSort = (typeof FAQ_SORTS)[number];
export const FAQ_PAGE_SIZE = 25;
const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Client table state (useListState). The "Page" filter takes any page key (products come and go). */
export const FAQS_LIST = defineListState<"page" | "status">({
  filterStyle: "bracket",
  filters: { page: {}, status: { values: FAQ_STATUSES } },
  sortable: FAQ_SORTS,
  defaultSort: { id: "order", desc: false },
  pageSize: FAQ_PAGE_SIZE,
  // The table's own "page" parameter is the pager; the FAQ page filter is filter[page].
});

/** Server parsing of the same URL (GET /api/admin/faqs, its CSV export and the page). */
export const FAQ_LIST_SPEC = {
  filters: { page: (raw: string) => (PAGE_KEY_RE.test(raw) ? raw : undefined), status: FAQ_STATUSES },
  sortable: FAQ_SORTS,
  defaultSort: { id: "order", desc: false },
  defaultPageSize: FAQ_PAGE_SIZE,
} satisfies ListQuerySpec<{ page: (raw: string) => string | undefined; status: typeof FAQ_STATUSES }, FaqSort>;

export type FaqListQuery = {
  q: string;
  filters: { page?: string; status?: FaqStatus };
  sort: { id: FaqSort; desc: boolean };
};

/**
 * Search (question, answer, page), page and status filters and sort. "order" sorts by page (fixed pages, then products
 * in catalog order) and position, which is how the storefront shows them.
 */
export function filterAndSortFaqs(rows: readonly FaqDto[], query: FaqListQuery, pages: readonly FaqPageOption[]): FaqDto[] {
  const q = query.q.trim().toLowerCase();
  const rank = new Map(pages.map((p, i) => [p.value, i]));
  const pageRank = (f: FaqDto) => rank.get(f.page) ?? pages.length;
  const dir = query.sort.desc ? -1 : 1;
  const byOrder = (a: FaqDto, b: FaqDto) => pageRank(a) - pageRank(b) || a.page.localeCompare(b.page) || a.position - b.position;
  const compare: Record<FaqSort, (a: FaqDto, b: FaqDto) => number> = {
    order: byOrder,
    question: (a, b) => a.question.localeCompare(b.question),
    page: (a, b) => a.pageLabel.localeCompare(b.pageLabel) || a.position - b.position,
  };
  return rows
    .filter(
      (f) =>
        (!query.filters.page || f.page === query.filters.page) &&
        (!query.filters.status || f.status === query.filters.status) &&
        (!q || `${f.question} ${f.answer} ${f.pageLabel}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => dir * (compare[query.sort.id](a, b) || byOrder(a, b) || a.id.localeCompare(b.id)));
}

// ---------- Site banner and sample notice (SiteSetting content.banner / content.sampleNotice) ----------

export const CONTENT_NOTICE_KEYS = ["banner", "sample-notice"] as const;
export type ContentNoticeKey = (typeof CONTENT_NOTICE_KEYS)[number];

export type ContentNoticeDto = { enabled: boolean; text: string; updatedAt: string | null };

export const NOTICE_TEXT_MAX = 200;

export const CONTENT_NOTICE_COPY: Readonly<
  Record<ContentNoticeKey, { title: string; description: string; inputLabel: string; on: string; off: string; saved: string }>
> = {
  banner: {
    title: "Site announcement banner",
    description: "Shown above the header on every storefront page.",
    inputLabel: "Banner text",
    on: "Banner updated",
    off: "Banner updated",
    saved: "Banner saved",
  },
  "sample-notice": {
    title: "Sample content notice",
    description: "The strip at the top of every storefront page that says prices, policies and screenshots are samples. Turn it off before launch.",
    inputLabel: "Sample notice text",
    on: "Sample notice updated",
    off: "Sample notice updated",
    saved: "Sample notice saved",
  },
};

/** Prototype copy plus the new states (owner review). */
export const FAQ_COPY = {
  searchPlaceholder: "Search questions and answers",
  searchLabel: "Search FAQs",
  caption: "FAQs",
  newFaq: "New FAQ",
  created: "Draft FAQ added",
  saved: "Changes saved",
  updated: "FAQ updated",
  deleted: "FAQ deleted",
  unpublished: "Unpublished",
  published: "Published",
  moved: "FAQ moved",
  noChanges: "No changes to save",
  deleteConsequence: "It disappears from the storefront. This can\u2019t be undone.",
} as const;

export const FAQ_ERRORS = {
  question: "Write the question (5 to 300 characters).",
  answer: "Write the answer (5 to 3,000 characters).",
  href: "Use a link on this site that starts with /, such as /docs/activation.",
  page: "Choose a page from the list.",
  ids: "Select up to 100 FAQs.",
  direction: "Choose up or down.",
  bannerText: "Enter the banner text (up to 200 characters).",
  noticeText: "Keep the text to 200 characters or fewer.",
  nothingToSave: "Change a field before saving.",
} as const;
