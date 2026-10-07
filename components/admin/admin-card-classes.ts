/**
 * Classes of the admin phone card (Admin Console.dc.html mobile rows: `display:grid;gap:6px`; a title row with
 * `justify-content:space-between;gap:10px`; title `font-weight:800;font-size:14px` in the body font; badge; subtitle
 * `font-size:12.5px;color:#4B5567;font-weight:600`). Used by <AdminCardContent>; pure, so unit tests can check them.
 */
export const ADMIN_CARD_CLASSES = {
  root: "grid min-w-0 gap-1.5",
  head: "flex min-w-0 items-start justify-between gap-2.5",
  title: "min-w-0 break-words text-[14px] font-extrabold",
  badge: "flex shrink-0",
  subtitle: "block min-w-0 break-words text-[12.5px] font-semibold text-ink-2",
} as const;
