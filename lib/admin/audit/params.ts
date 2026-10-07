/**
 * Next.js page `searchParams` (a record) as URLSearchParams, so server pages read the same list query as the API
 * routes (lib/admin/list-query parseListQuery). Pure.
 */
export type PageSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

export function toUrlSearchParams(params: PageSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") out.append(key, value);
    else if (value) for (const item of value) out.append(key, item);
  }
  return out;
}

/** First value of a parameter (Next passes repeated parameters as arrays). */
export function firstParam(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** The drawer id from ?id= when it looks like an id, else null. */
export function drawerIdParam(params: PageSearchParams): string | null {
  const raw = firstParam(params.id)?.trim();
  return raw && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(raw) ? raw : null;
}
