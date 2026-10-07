/**
 * Client cart (docs/decisions.md: the cart is client state; the server always re-prices at checkout).
 *
 * Persisted in localStorage under "axiomatic.cart" as { v: 1, items: [...] } and validated on every read,
 * so a corrupted or hand-edited value can never break a page (invalid lines are dropped). Other tabs follow through
 * the `storage` event. The server snapshot is always empty: the header badge fills in after hydration.
 *
 * Also exports createSyncedStore(), the small localStorage-backed external store shared with lib/compare/store.ts.
 */
// ---------- Generic localStorage-backed store for useSyncExternalStore ----------

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SyncedStoreOptions<T> = {
  key: string;
  /** Raw stored string (or null) -> value. Must never throw. */
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  /** The value before hydration and when nothing is stored. Also the server snapshot. */
  empty: T;
  /** Storage accessor (tests pass a fake); defaults to window.localStorage when available. */
  storage?: () => StorageLike | null;
  /** Target for the cross-tab `storage` event; defaults to window when available. */
  events?: () => Pick<Window, "addEventListener" | "removeEventListener"> | null;
};

export type SyncedStore<T> = {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  set: (next: T) => void;
};

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage blocked (privacy settings, sandboxed frames)
  }
}

function browserEvents(): Pick<Window, "addEventListener" | "removeEventListener"> | null {
  return typeof window === "undefined" ? null : window;
}

/**
 * External store over one localStorage key. Snapshots are cached per raw string, so useSyncExternalStore sees a
 * stable reference until the stored value changes (in this tab or another). When storage is unavailable or full,
 * the value lives in memory for this page.
 */
export function createSyncedStore<T>(opts: SyncedStoreOptions<T>): SyncedStore<T> {
  const storage = opts.storage ?? browserStorage;
  const events = opts.events ?? browserEvents;
  const listeners = new Set<() => void>();
  let memory: string | null = null;
  let memoryOnly = false;
  let lastRaw: string | null | undefined;
  let lastValue: T = opts.empty;

  const readRaw = (): string | null => {
    const s = memoryOnly ? null : storage();
    if (!s) return memory;
    try {
      return s.getItem(opts.key);
    } catch {
      return memory;
    }
  };

  const getSnapshot = (): T => {
    const raw = readRaw();
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastValue = opts.parse(raw);
    }
    return lastValue;
  };

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const set = (next: T) => {
    const raw = opts.serialize(next);
    memory = raw;
    const s = memoryOnly ? null : storage();
    if (s) {
      try {
        s.setItem(opts.key, raw);
      } catch {
        memoryOnly = true; // quota exceeded or storage disabled: keep this page consistent in memory
      }
    }
    emit();
  };

  const onStorage = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === null || key === opts.key) emit();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1) events()?.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) events()?.removeEventListener("storage", onStorage);
    };
  };

  return { getSnapshot, getServerSnapshot: () => opts.empty, subscribe, set };
}

// ---------- Cart ----------

export const CART_STORAGE_KEY = "axiomatic.cart";
export const CART_MAX_LINES = 50;
/** Absolute per-line ceiling (the prototype's cart cap); plans set lower limits through maxQty. */
export const CART_MAX_QTY = 99;

/** Same values as the ItemKind enum in prisma/schema.prisma (lib/pricing ITEM_KIND_PLAN_TYPES). */
export const CART_ITEM_KINDS = ["NEW", "RENEWAL", "ADDON", "UPGRADE"] as const;
export type CartItemKind = (typeof CART_ITEM_KINDS)[number];

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A plan or license id: a string that, trimmed, has 1-64 characters of [A-Za-z0-9_-]. Returns the trimmed id, or null.
 * Hand-written (no Zod) so the storefront bundle does not ship a schema library for three fields.
 */
function parseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length >= 1 && id.length <= 64 && ID_PATTERN.test(id) ? id : null;
}

/** A whole number from 1 to CART_MAX_QTY. */
function isQty(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= CART_MAX_QTY;
}

function isCartItemKind(value: unknown): value is CartItemKind {
  return (CART_ITEM_KINDS as readonly unknown[]).includes(value);
}

type StoredLine = {
  planId: string;
  qty: number;
  /** Highest quantity the product page allowed when the line was added (clamps the cart stepper). */
  maxQty?: number;
  kind?: CartItemKind;
  targetLicenseId?: string | null;
};

/** One stored line, or null when any field is invalid (unknown keys are ignored). */
function parseStoredLine(value: unknown): StoredLine | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { planId: rawPlanId, qty, maxQty, kind, targetLicenseId: rawTarget } = value as Record<string, unknown>;
  const planId = parseId(rawPlanId);
  if (planId === null || !isQty(qty)) return null;
  if (maxQty !== undefined && !isQty(maxQty)) return null;
  if (kind !== undefined && !isCartItemKind(kind)) return null;
  const targetLicenseId = rawTarget === undefined || rawTarget === null ? rawTarget : parseId(rawTarget);
  if (targetLicenseId === null && rawTarget !== null) return null;
  return { planId, qty, maxQty, kind, targetLicenseId };
}

export type CartItem = {
  /** Stable line id: kind, plan and target license. */
  key: string;
  planId: string;
  qty: number;
  maxQty: number;
  kind: CartItemKind;
  /** The license a RENEWAL, ADDON or UPGRADE line applies to; null for NEW lines. */
  targetLicenseId: string | null;
};

export type CartSnapshot = {
  items: readonly CartItem[];
  /** Sum of quantities (the header badge), not the number of lines. */
  count: number;
};

export type AddToCartOptions = {
  qty?: number;
  /** Product pages pass maxQtyFor(plan): perUnit ? (maxQty ?? 10) : 1. */
  maxQty: number;
  kind?: CartItemKind;
  targetLicenseId?: string | null;
};

export type AddToCartResult =
  | { ok: true; item: CartItem; /** The requested quantity was reduced to the line's maximum. */ capped: boolean }
  | { ok: false; reason: "invalid" | "full" };

export function cartLineKey(line: { kind: CartItemKind; planId: string; targetLicenseId: string | null }): string {
  return `${line.kind}:${line.planId}:${line.targetLicenseId ?? ""}`;
}

const EMPTY_CART: CartSnapshot = Object.freeze({ items: Object.freeze([]) as readonly CartItem[], count: 0 });

function snapshotOf(items: CartItem[]): CartSnapshot {
  if (items.length === 0) return EMPTY_CART;
  return { items, count: items.reduce((n, i) => n + i.qty, 0) };
}

/** Parses a stored cart. Accepts { v: 1, items } and the prototype's bare array; drops invalid lines. */
export function parseCart(raw: string | null): CartSnapshot {
  if (!raw) return EMPTY_CART;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_CART;
  }
  const lines: unknown = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(lines)) return EMPTY_CART;
  const byKey = new Map<string, CartItem>();
  for (const line of lines) {
    const parsed = parseStoredLine(line);
    if (!parsed) continue;
    const { planId, qty, kind = "NEW" } = parsed;
    const targetLicenseId = parsed.targetLicenseId ?? null;
    const maxQty = parsed.maxQty ?? qty;
    const key = cartLineKey({ kind, planId, targetLicenseId });
    const existing = byKey.get(key);
    if (existing) {
      existing.qty = Math.min(existing.maxQty, existing.qty + qty);
      continue;
    }
    if (byKey.size >= CART_MAX_LINES) continue;
    byKey.set(key, { key, planId, qty: Math.min(qty, maxQty), maxQty, kind, targetLicenseId });
  }
  return snapshotOf([...byKey.values()]);
}

export function serializeCart(snapshot: CartSnapshot): string {
  return JSON.stringify({
    v: 1,
    items: snapshot.items.map(({ planId, qty, maxQty, kind, targetLicenseId }) => ({ planId, qty, maxQty, kind, targetLicenseId })),
  });
}

const clampQty = (qty: number, max: number) => Math.min(Math.max(1, Math.trunc(qty)), max);

export type CartStore = Pick<SyncedStore<CartSnapshot>, "getSnapshot" | "getServerSnapshot" | "subscribe"> & {
  /** Adds a line, or raises the quantity of the same line (same kind, plan and target license) up to its maximum. */
  add: (planId: string, opts: AddToCartOptions) => AddToCartResult;
  /** Sets a line's quantity, clamped to 1..maxQty. */
  setQty: (key: string, qty: number) => void;
  remove: (key: string) => void;
  clear: () => void;
};

export function createCartStore(
  opts: Pick<SyncedStoreOptions<CartSnapshot>, "storage" | "events"> = {},
): CartStore {
  const store = createSyncedStore<CartSnapshot>({
    key: CART_STORAGE_KEY,
    parse: parseCart,
    serialize: serializeCart,
    empty: EMPTY_CART,
    ...opts,
  });

  const add = (planId: string, options: AddToCartOptions): AddToCartResult => {
    const kind = options.kind ?? "NEW";
    const targetLicenseId = options.targetLicenseId ?? null;
    const requested = options.qty ?? 1;
    if (
      parseId(planId) === null ||
      !isQty(requested) ||
      !isQty(options.maxQty) ||
      (targetLicenseId !== null && parseId(targetLicenseId) === null)
    ) {
      return { ok: false, reason: "invalid" };
    }
    const maxQty = options.maxQty;
    const key = cartLineKey({ kind, planId, targetLicenseId });
    const items = [...store.getSnapshot().items];
    const index = items.findIndex((i) => i.key === key);
    const current = index >= 0 ? items[index] : undefined;
    if (!current && items.length >= CART_MAX_LINES) return { ok: false, reason: "full" };
    const wanted = (current?.qty ?? 0) + requested;
    const item: CartItem = { key, planId, kind, targetLicenseId, maxQty, qty: Math.min(wanted, maxQty) };
    if (current) items[index] = item;
    else items.push(item);
    store.set(snapshotOf(items));
    return { ok: true, item, capped: wanted > maxQty };
  };

  const setQty = (key: string, qty: number) => {
    if (!Number.isFinite(qty)) return;
    const items = store.getSnapshot().items;
    const current = items.find((i) => i.key === key);
    if (!current) return;
    const next = clampQty(qty, current.maxQty);
    if (next === current.qty) return;
    store.set(snapshotOf(items.map((i) => (i.key === key ? { ...i, qty: next } : i))));
  };

  const remove = (key: string) => {
    const items = store.getSnapshot().items;
    if (!items.some((i) => i.key === key)) return;
    store.set(snapshotOf(items.filter((i) => i.key !== key)));
  };

  const clear = () => store.set(EMPTY_CART);

  return {
    getSnapshot: store.getSnapshot,
    getServerSnapshot: store.getServerSnapshot,
    subscribe: store.subscribe,
    add,
    setQty,
    remove,
    clear,
  };
}

/** The page-wide cart (window.localStorage). Use it through useCart() in components. */
export const cartStore: CartStore = createCartStore();
