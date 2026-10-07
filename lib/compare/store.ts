/**
 * Compare selection (catalog tray and /compare): at most 3 product slugs, client state in localStorage under
 * "axiomatic.compare" (a JSON array, the prototype's format), validated on every read. /compare?ids=a,b,c carries
 * the selection in links; call replace() with the URL ids to adopt them.
 */
import { createSyncedStore, type SyncedStoreOptions } from "@/lib/cart/store";

export const COMPARE_STORAGE_KEY = "axiomatic.compare";
export const COMPARE_MAX = 3;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A product slug (at most 64 characters of lower-case words joined by single hyphens). No Zod: storefront bundle. */
function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SLUG_PATTERN.test(value);
}

export type CompareIds = readonly string[];

export type CompareToggleResult = { ok: true; /** True when the product is now selected. */ selected: boolean } | { ok: false; reason: "max" };

const EMPTY: CompareIds = Object.freeze([]) as CompareIds;

/** Valid slugs, deduplicated, at most COMPARE_MAX, in order. */
export function normalizeCompareIds(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= COMPARE_MAX) break;
    if (isSlug(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** "a,b,c" from /compare?ids= -> normalized ids. */
export function parseCompareParam(param: string | null | undefined): string[] {
  return param ? normalizeCompareIds(param.split(",").map((s) => s.trim())) : [];
}

export function parseCompare(raw: string | null): CompareIds {
  if (!raw) return EMPTY;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return EMPTY;
    const ids = normalizeCompareIds(data);
    return ids.length > 0 ? ids : EMPTY;
  } catch {
    return EMPTY;
  }
}

export type CompareStore = {
  getSnapshot: () => CompareIds;
  getServerSnapshot: () => CompareIds;
  subscribe: (listener: () => void) => () => void;
  /** Adds or removes a product; refuses a 4th ({ ok: false, reason: "max" }). */
  toggle: (id: string) => CompareToggleResult;
  remove: (id: string) => void;
  /** Replaces the selection (e.g. with the ids from /compare?ids=); extra or invalid ids are dropped. */
  replace: (ids: readonly string[]) => void;
  clear: () => void;
};

export function createCompareStore(
  opts: Pick<SyncedStoreOptions<CompareIds>, "storage" | "events"> = {},
): CompareStore {
  const store = createSyncedStore<CompareIds>({
    key: COMPARE_STORAGE_KEY,
    parse: parseCompare,
    serialize: (ids) => JSON.stringify(ids),
    empty: EMPTY,
    ...opts,
  });

  const toggle = (id: string): CompareToggleResult => {
    const ids = store.getSnapshot();
    if (ids.includes(id)) {
      store.set(ids.filter((x) => x !== id));
      return { ok: true, selected: false };
    }
    if (ids.length >= COMPARE_MAX) return { ok: false, reason: "max" };
    if (!isSlug(id)) return { ok: true, selected: false };
    store.set([...ids, id]);
    return { ok: true, selected: true };
  };

  const remove = (id: string) => {
    const ids = store.getSnapshot();
    if (ids.includes(id)) store.set(ids.filter((x) => x !== id));
  };

  const replace = (next: readonly string[]) => {
    const ids = normalizeCompareIds(next);
    const current = store.getSnapshot();
    if (ids.length === current.length && ids.every((x, i) => x === current[i])) return;
    store.set(ids);
  };

  return {
    getSnapshot: store.getSnapshot,
    getServerSnapshot: store.getServerSnapshot,
    subscribe: store.subscribe,
    toggle,
    remove,
    replace,
    clear: () => store.set(EMPTY),
  };
}

/** The page-wide selection (window.localStorage). Use it through useCompare() in components. */
export const compareStore: CompareStore = createCompareStore();
