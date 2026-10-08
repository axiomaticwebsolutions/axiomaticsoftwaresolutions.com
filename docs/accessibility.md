# Accessibility

Target: **WCAG 2.1 level AA** for every page a customer or staff member can reach (storefront, cart and checkout,
sign-in and account pages, the order page, the customer portal and the admin console), plus two checks that are cheap
to keep: focus not obscured (2.4.11, new in WCAG 2.2) and honouring reduced motion (2.3.3, level AAA).
Development-only pages (`/dev/*`) are out of scope. This file records how the Phase 7 pass was done (2026-10-07/08),
what it found and fixed, and what is still open. Binding design rules stay in `docs/decisions.md`.

## How to check

| Command | What it covers |
|---|---|
| `node scripts/check-storefront.mjs` | Every storefront, cart, checkout and auth page at 1280 and 360px: status, console, one `<h1>` and one `<main>`, title, overflow, axe (WCAG 2.0 A/AA + 2.1 AA) |
| `node scripts/check-portal.mjs --only=pages` | Every `/account` page as Owner, Billing admin and Technical contact at 1280 and 360px (same checks) |
| `node scripts/check-admin.mjs --only=pages` | Every `/admin` module (and drawers) plus My profile (`/admin/profile`) as Owner, Administrator, Support and Finance at 1280 and 360px (same checks) |
| `node scripts/check-a11y.mjs` | The states the crawls never reach (below). `--only=focus,store,auth,orders,portal,admin,reflow,motion,forced` runs a subset; `--base=URL` targets another dev server |
| `pnpm test:unit` | `tests/unit/a11y-pass.test.ts`, `design-a11y.test.ts` and `focus-outline-classes.test.ts` guard the rules below at source level |

`scripts/check-a11y.mjs` needs a dev server with `PAYMENT_PROVIDER=mock`, `EMAIL_TRANSPORT=console` and the seed. It
signs the demo Owner (Priya) and Administrator (Vikram) in over HTTP (staff code from `/dev/mailbox`), hands only the
session cookie to the browser and signs them out at the end. It writes nothing except sign-in records (sessions, one
unused two-step challenge for the seeded staff Owner, who has two-step on in the dev seed; sign-in code emails) and
rate-limit counters, and never prints passwords, codes, keys or tokens (URLs in error messages are masked).

## Method

1. **Automated crawls.** axe-core 4.13 with the tags `wcag2a`, `wcag2aa`, `wcag21aa` on every route at 1280 and
   360px, for every role (storefront 35 pages, portal 18 routes x 3 roles, admin 25 routes x 4 roles). A one-off run
   of axe's `best-practice` rules (heading order, landmarks, regions, duplicate names) over 45 pages found nothing.
2. **States the crawls never reach** (`check-a11y.mjs`): open menus, popovers, drawers and dialogs; error states of
   every form; the two-step code step; the order page in every payment state (awaiting payment, confirming, pending,
   paid, failed, canceled, refunded) through a signed guest link and as the account Owner; table selection; open
   comboboxes and listboxes. axe runs in each state.
3. **Keyboard-only walkthroughs**, scripted with real key presses in Chrome so they can be repeated: Tab walks through
   19 key pages at 1280px and 7 at 360px (skip link first and moving focus into `<main>`; a visible indicator on
   every stop; nothing focused under the sticky header, the product page's in-page nav or the compare tray; never a
   hidden or off-screen stop), and every complex widget (list below).
4. **Screen-reader semantics** from Chrome's accessibility tree: landmarks and their names, heading outlines, accessible
   names of controls, live regions and where they announce. No session with a real screen reader yet (see limitations).
5. **Contrast.** Every text and background token pair (`lib/design/tokens.ts`), plus a scan of every class list in
   `app/`, `components/` and `lib/` that sets both a text and a background colour, including `hover:`, `aria-pressed:`,
   `data-[highlighted]:` and opacity variants, and the focus ring against each surface it can sit on. axe measures the
   rendered pages and states.
6. **Zoom, reflow and text spacing.** 320 CSS px (1280px at 400%, WCAG 1.4.10) and 640px (200% zoom, 1.4.4) on 26 key
   pages; WCAG 1.4.12 text spacing (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em)
   injected at 360 and 1280px: no horizontal page scroll and no clipped text.
7. **Motion.** With `prefers-reduced-motion: reduce`: no CSS animation or transition longer than 1ms, no smooth
   scrolling, and every scripted smooth scroll checks the preference.
8. **Forced colours** (Windows contrast themes), emulated in Chrome: screenshots of the storefront, auth, portal and
   admin, then scripted checks of the fixes.

## Results

Before this pass every crawl was already clean (0 axe violations on 70 storefront, 105 portal and 196 admin page
loads); the earlier phases built the patterns in (labels and error wiring in `Field`, focus return for overlays,
skip links, polite live regions, aria-sort, `aria-disabled` buttons with a reason, listbox row selects, focusable
drawer bodies). The pass found the following, all fixed at the source:

| # | Finding | WCAG | Fix |
|---|---|---|---|
| 1 | Forced colours: states drawn only with a background vanished (selected tab, pressed toggle including Excl./Incl. GST and the admin date range, current page in the sidebars and header, highlighted menu item, highlighted search result or listbox option, current pagination page, checkout step) | 1.4.11, 1.3.1 | `app/globals.css`: in `@media (forced-colors: active)` those states (`aria-pressed`, `aria-current`, selected tab or option, highlighted menu item or option) use the system `Highlight` / `HighlightText` |
| 2 | Forced colours: the switch disappeared (track and thumb are both backgrounds) | 1.4.11 | `components/ui/switch.tsx`: outlined track, `CanvasText` thumb, `Highlight` track when on |
| 3 | Forced colours: solid buttons lost their outline and read as plain text ("Sign in", "Save profile") | 1.4.11 | `components/ui/button.tsx`: a `ButtonText` border in forced colours (link buttons excepted) |
| 4 | Forced colours: text fields showed focus only by a 1px border change (the focus ring is a box-shadow, which is dropped) | 2.4.7 | `outline-hidden` instead of `outline-none` on focus (a transparent outline the browser paints in forced colours): `Input`, `Textarea`, the Select trigger, the command palette, every search field, the portal dialogs |
| 5 | Forced colours: the radio dot vanished | 1.4.11 | `components/ui/radio-group.tsx`: `CanvasText` dot |
| 6 | Forced colours: charts and usage bars vanished | 1.4.11 | `forced-color-adjust: none` on the chart and bar containers (admin overview and reports, portal overview, device and coupon usage bars, upload progress) |
| 7 | `/contact` at 360px with WCAG text spacing scrolled sideways (7px): a long email address set the width of an auto grid column | 1.4.12, 1.4.10 | `contact-view.tsx` one `minmax(0,1fr)` column; `contact-aside.tsx` `overflow-wrap: anywhere` |
| 8 | `/admin` at 360px with text spacing scrolled sideways (6px): the product performance table could not shrink | 1.4.12, 1.4.10 | The table scrolls inside its panel (`ScrollRegion`) |
| 9 | Tables in plain `overflow-x-auto` wrappers (`ui/Table`, admin report tables, the team permission matrix) could not be scrolled from the keyboard once they overflowed (zoom, text spacing, a narrow panel); the release notes and the overview product table (#8) had no wrapper at all | 2.1.1 | New shared `components/ui/scroll-region.tsx` (from DataTable): a named, focusable region only while it overflows; used by DataTable, `ui/Table`, `ReportTable`, the overview product table, the permission matrix and the release notes |
| 10 | Global search and admin module search: when results overflowed, the scrolling wrapper was not keyboard reachable (axe `scrollable-region-focusable`) | 2.1.1 | The listbox itself scrolls; arrow keys move `aria-activedescendant` and keep the option in view |
| 11 | Focus rings on toast actions were 2.9:1 against the dark toast | 1.4.11 | Toasters use `primary-accent` (8.1:1) for rings inside toasts |
| 12 | Cart and checkout summaries were dimmed to 70% while re-pricing and stayed dimmed after a failed quote: secondary text 3.6:1 | 1.4.3 | Dimmed to 85% (secondary text 5.1:1, sage discount line 4.6:1) |
| 13 | The checkout error summary scrolled into view smoothly even with reduced motion | 2.3.3 | `checkout-view.tsx` honours `prefers-reduced-motion` |
| 14 | `ConfirmDialog` inside another form (Delete category) also submitted that form when confirmed (React events cross portals) | (bug) | `components/ui/confirm-dialog.tsx` stops the submit event (Q1 request) |
| 15 | Release history triggers rely on the browser adding a space after the hidden ", released" | 4.1.2 | The hidden text ends with a space |

Verified and passing (no change needed):

- **Landmarks and headings**: one `<main>` and one `<h1>` per page; named navigation landmarks (Primary, Account,
  Admin, Breadcrumb, On this page, footer groups); sections named by their headings; no skipped heading levels.
- **Skip links** on the storefront, checkout, portal and admin shells move focus into `<main>`.
- **Menus and popovers** (Software mega menu, help, notifications, business switcher, account menus): Enter or the
  arrow keys open them, focus moves in, arrows move, Escape closes and focus returns to the trigger, `aria-expanded`.
- **Dialogs and drawers** (mobile menu, catalog filters, portal and admin sidebars at 360px, key reveal, admin detail
  drawer, destructive dialogs nested in it): named, modal, focus moves in, Tab and Shift+Tab stay inside, Escape closes,
  focus returns to the opener (to the button inside the drawer for a nested dialog).
- **Destructive dialogs**: confirm stays disabled until a reason (and the typed id) is given; the reason field is
  labelled; errors are `role="alert"`.
- **Tabs** (product screenshots, license detail): arrow keys select, each tab controls its panel.
- **Comboboxes** (global search, admin module search): Ctrl+K, arrows move `aria-activedescendant`, a polite status
  says how many results, Escape closes then clears. **Row selects** that act on change (device location, member role):
  arrows only browse, Escape changes nothing, focus returns to the trigger (3.2.2).
- **Data tables**: sortable headers are buttons, `aria-sort` on the sorted column, focus stays on the header; row
  checkboxes are named, the bulk bar's count is announced, Clear keeps focus on the page.
- **Toasts**: Sonner's polite live region; the add-to-cart toast keeps focus on the button; Alt+T reaches the toasts
  and pauses their timers.
- **Forms**: checkout, sign-in, register, forgot password and the two-step code: an empty submit focuses the error
  summary (`role="alert"`), every invalid field has `aria-invalid`, a label and a described message, summary links
  focus their field; a refused password shows an alert banner and keeps focus on the button; the code field is
  labelled, numeric and `autocomplete="one-time-code"`, and focus lands on it.
- **Order page**: one `<h1>` in a polite status region in every payment state, at 1280 and 360px.
- **Reflow**: 26 pages at 320 and 640px with no page scroll; tables and the pricing and compare matrices scroll in
  their own focusable regions (the 1.4.10 exception for data tables).
- **Reduced motion**: global CSS turns animations, transitions and smooth scrolling off; spinners and skeletons stop.

## Contrast

Ratios against the surfaces each pair is used on (WCAG 1.4.3 needs 4.5:1 for text, 3:1 for large text; 1.4.11 needs
3:1 for control boundaries, focus indicators and meaningful graphics).

| Foreground | On | Ratio | Use |
|---|---|---|---|
| ink `#172033` | white / bg / portal / admin | 16.3 / 15.6 / 15.2 / 14.9 | body text |
| ink-2 `#4B5567` | white / bg / admin / tinted tone backgrounds | 7.5 / 7.2 / 6.9 / 6.3-6.7 | secondary text |
| ink-3 `#667085` | white / bg / portal / admin | 5.0 / 4.8 / 4.7 / 4.6 | placeholders, small labels, icons; never on tinted backgrounds |
| primary-link `#5547C2` | white / lavender-bg | 6.9 / 5.8 | links |
| tone fg on its tone bg | lavender, sage, blue, peach, pink | 6.7, 5.7, 7.2, 6.1, 6.1 | badges, notices, active nav |
| danger `#A3273F` | white / pink-bg | 7.2 / 6.1 | errors |
| white | primary / danger / peach-fg / ink | 5.6 / 7.2 / 6.8 / 16.3 | solid buttons, toasts, tooltips |
| white at 90% hover | danger / peach-fg | 5.9 / 5.4 | hover of solid buttons |
| lavender-fg | lavender-line (hover) | 5.6 | subtle buttons, banner close |
| admin-text `#C9CFDB` | admin sidebar / active item / toast | 10.4 / 8.4 / 10.4 | admin sidebar, toast descriptions |
| white at 65% | ink | 7.6 | home "How it works" step labels |
| Focus ring primary `#6355CF` | white / bg / portal / admin | 5.6 / 5.4 / 5.3 / 5.2 | every light surface |
| Focus ring primary-accent `#B9AEF2` | ink / admin active | 8.1 / 6.5 | admin sidebar, toasts |
| line.control `#7C8597` | white / admin | 3.7 / 3.4 | checkbox, radio and switch boundaries |
| success `#2F8F5B` (icons only) | white | 4.0 | check marks |
| warn.bar `#C26A1F` (graphics only) | white | 3.9 | full device-slot bars |

Disabled controls (`opacity-55`) are exempt. Rows of a table that is loading are dimmed to 60% for a moment
(`aria-busy`); see limitations.

## Known limitations

1. **No session with real assistive technology yet.** The pass used axe, Chrome's accessibility tree and scripted
   keyboard use. Before live sales, run the purchase journey, sign-in with two-step, the license page and one admin
   refund with NVDA + Chrome and VoiceOver on iOS, and a short pass in a real Windows contrast theme (the forced-colours
   checks here are Chrome emulation).
2. **License keys hide after 60 seconds** on the order page and the license page, with no "keep showing" control
   (handoff and decision 10: a security measure). WCAG 2.2.1 has no security exception, so this is an accepted
   deviation for the owner to confirm. Mitigations: the time left is shown, the reveal and the hiding are announced,
   Copy key is one action, the portal can reveal again (with the password) and a guest can reveal later from an account.
3. **Toasts time out** (3.2 s; 6 s with actions; 10 s for the invitation email warning). Hovering them or Alt+T pauses
   them; reaching a toast with Tab does not (Sonner). Rule: a toast never carries the only copy of information or the
   only way to an action (the cart toast repeats the header cart button; the invitation warning repeats "Resend").
4. **Brief dimming**: data-table rows fade to 60% while a page of results loads (`aria-busy`, typically under a
   second); text is below 4.5:1 only during that time.
5. **axe false positive accepted in one state**: an open Radix Select (row selects) hides the rest of the page with
   `aria-hidden` while it traps focus, and axe reports `aria-hidden-focus` because it only treats dialogs as modal.
   `check-a11y.mjs` skips that rule for that state only.
6. **The team members table** scrolls inside a plain wrapper below about 700px of card width; every row holds controls,
   so Tab scrolls it.
7. **Charts**: the admin revenue chart is hidden from assistive technology and has a visually hidden data table; the
   other bars repeat numbers shown next to them. In forced colours the bars keep their brand colours.
8. **Invoice PDFs are untagged** (react-pdf). The same invoice is on the order page as HTML (Print invoice).
9. **WCAG 2.2 target size** (2.5.8, not part of 2.1 AA) was not audited: some table checkboxes are 16px and some icon
   buttons 28px.
10. **Emails** were not part of the pass beyond `lang` and presentation tables (`lib/email/layout.ts`).

## Rules for new UI

- Use the shared primitives (`Field`, `Input`, `Button`, `Dialog`/`Sheet`/`ConfirmDialog`, `DataTable`, `Tabs`,
  `SegmentedControl`, `RowSelect`, `ScrollRegion`); they carry the labelling, focus return, live regions and the
  forced-colours behaviour above.
- Hide a focus outline with `outline-hidden`, never `outline-none`, on anything that can take keyboard focus.
- Show a selected, pressed or current state with ARIA (`aria-selected`, `aria-pressed`, `aria-current`) and not with
  a background alone; the forced-colours rules key off those attributes.
- Put wide tables in a `ScrollRegion` (or the `Table` primitive); the page itself must never scroll sideways.
- Keep text at 4.5:1 in every state that can last (including errors and stale data); dim with 85% opacity at most.
- Check `prefers-reduced-motion` before any scripted smooth scroll or animation.
- Run `node scripts/check-a11y.mjs` and the crawls after UI changes; extend `check-a11y.mjs` for new widgets.

## Latest run (2026-10-08, development server, after the fixes)

| Check | Result |
|---|---|
| `check-storefront.mjs` | 77 checks (35 pages x 2 widths + resources), 0 failures, 0 axe violations |
| `check-portal.mjs --only=pages` | 105 page loads, 1,059 checks, 0 failures |
| `check-admin.mjs --only=pages` | 196 page loads, 2,041 checks, 0 failures |
| `check-a11y.mjs` | 569 checks, 0 failures (focus, store, auth, orders, portal, admin, reflow, motion, forced) |
| `tests/unit/a11y-pass.test.ts` | 8 tests pass (with the rest of the unit suite) |
