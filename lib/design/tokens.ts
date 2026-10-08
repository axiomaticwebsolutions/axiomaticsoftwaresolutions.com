/**
 * Design tokens from design_handoff_axiomatic/README.md > Design tokens.
 * Single source of truth: tailwind.config.mts reads this file, and charts/emails can import it directly.
 */

export const tones = {
  lavender: { bg: "#EEE9FF", fg: "#4B3FB0", soft: "#F6F3FF", line: "#DCD3FB" },
  sage: { bg: "#E7F3EC", fg: "#1F6B45", soft: "#F2F9F5", line: "#CFE6D8" },
  blue: { bg: "#E9F1FC", fg: "#1F4F8F", soft: "#F3F7FD", line: "#CFDFF5" },
  peach: { bg: "#FFF0E5", fg: "#8A4B12", soft: "#FFF7F1", line: "#F7D9C2" },
  pink: { bg: "#FCE7EF", fg: "#A3273F", soft: "#FDF3F7", line: "#F5CFDC" },
} as const;

export type Tone = keyof typeof tones;
export const TONE_NAMES = Object.keys(tones) as Tone[];

export const palette = {
  bg: { DEFAULT: "#F8FAFC", portal: "#F6F7FB", admin: "#F4F5F9" },
  surface: "#FFFFFF",
  ink: {
    DEFAULT: "#172033",
    "2": "#4B5567", // secondary text, 7.5:1 on white
    "3": "#667085", // placeholders/icons on white; also replaces #9AA3B2 for text (contrast fix)
    body: "#3A4456",
    soft: "#2E3B4F",
  },
  line: {
    DEFAULT: "#E6E8F0",
    alt: "#E3E6EE",
    subtle: "#EEF0F5",
    input: "#CBD2DF",
    strong: "#DDE2EA",
    // Boundary of unchecked checkboxes/radios and the switch off-track: 3.7:1 on white, 3.4:1 on bg.admin
    // (WCAG 1.4.11 needs 3:1; line.input is 1.5:1). Same value as muted.icon.
    control: "#7C8597",
  },
  primary: {
    DEFAULT: "#6355CF",
    hover: "#5446BD",
    link: "#5547C2",
    "link-hover": "#3F33A0",
    ring: "#E2DBFF",
    accent: "#B9AEF2",
    foreground: "#FFFFFF",
  },
  ...tones,
  slate: { bg: "#EEF1F6", fg: "#4B5567" },
  danger: { DEFAULT: "#A3273F", border: "#C2416B" },
  success: { DEFAULT: "#2F8F5B", soft: "#A8E0BF" },
  muted: { icon: "#7C8597" }, // replaces #B4BCC9 for meaningful icons (>= 3:1 on white)
  admin: { sidebar: "#172033", active: "#2E2A5E", text: "#C9CFDB" },
  skeleton: { DEFAULT: "#EEF0F5", alt: "#E6E9F0" },
  // Brand-asset colours (README > Brand assets), not UI colours: the peach crossbar of the logo mark.
  brand: { "mark-accent": "#FFC9A8" },
  // Prototype-only shades: the dark-brown text of peach notices (their icon stays peach.fg, 6.1:1 either way) and the
  // light lavender hover of the docs sidebar and legal TOC links (lavender.bg is the current-page colour).
  notice: { ink: "#5A3410" },
  // The prototype's "full" orange (chartColors[3]): used slots of a full license and renewal dots within 60 days.
  // Graphics only (3.9:1 on white meets WCAG 1.4.11's 3:1); never text (use peach.fg).
  warn: { bar: "#C26A1F" },
  hover: { lavender: "#F1EEFF" },
} as const;

export const chartColors = ["#6355CF", "#B9AEF2", "#2F8F5B", "#C26A1F", "#C2416B", "#3A72C4", "#9AA3B2"] as const;

/** shadcn/ui semantic names, aliased to the palette (never new values). */
export const semantic = {
  background: palette.bg.DEFAULT,
  foreground: palette.ink.DEFAULT,
  card: { DEFAULT: palette.surface, foreground: palette.ink.DEFAULT },
  popover: { DEFAULT: palette.surface, foreground: palette.ink.DEFAULT },
  secondary: { DEFAULT: palette.slate.bg, foreground: palette.ink.DEFAULT },
  accent: { DEFAULT: tones.lavender.bg, foreground: tones.lavender.fg },
  destructive: { DEFAULT: palette.danger.DEFAULT, foreground: "#FFFFFF" },
  border: palette.line.DEFAULT,
  input: palette.line.input,
  ring: palette.primary.DEFAULT,
} as const;

export const radii = {
  "6": "6px",
  "8": "8px", // small controls, admin inputs
  "9": "9px",
  "10": "10px", // inputs, nav items
  "12": "12px", // buttons
  "13": "13px",
  "14": "14px", // hero buttons, dashboard cards
  "16": "16px",
  "18": "18px",
  "20": "20px", // cards
  "22": "22px",
  "24": "24px", // bands
  "28": "28px",
  "32": "32px", // hero panels
  pill: "9999px",
} as const;

export const shadows = {
  "card-hover": "0 18px 40px rgba(23,32,51,.09)",
  menu: "0 24px 60px rgba(23,32,51,.14)",
  dialog: "0 30px 70px rgba(23,32,51,.3)",
  toast: "0 12px 30px rgba(23,32,51,.25)",
  primary: "0 8px 20px rgba(99,85,207,.28)",
  tile: "0 4px 14px rgba(23,32,51,.06)",
  focus: "0 0 0 4px #E2DBFF",
} as const;

/**
 * README breakpoints, in rem like Tailwind's own sm/md/lg/xl (40/48/64/80rem). Tailwind sorts breakpoints only
 * within one unit, so px screens would be emitted before every rem one and lose to md:/lg: at any width.
 */
export const screens = {
  cards: "47.5rem", // 760px: tables become cards below
  catalog: "56.25rem", // 900px: catalog filters become a drawer below
  nav: "60rem", // 960px: storefront nav collapses below
  portal: "62.5rem", // 1000px: portal sidebar becomes a drawer below
  admin: "65rem", // 1040px: admin sidebar becomes a drawer below
} as const;

export const layout = {
  storeMax: "1240px",
  portalMax: "1240px",
  adminMax: "1760px", // fills a 1920px screen next to the 232px sidebar (the prototype's 1360px left wide gutters)
} as const;

export const fontSizes = {
  display: ["clamp(40px, 5.6vw, 68px)", { lineHeight: "1.02", letterSpacing: "-0.04em", fontWeight: "800" }],
  "h1-product": ["clamp(34px, 4.4vw, 54px)", { lineHeight: "1.04", letterSpacing: "-0.04em", fontWeight: "800" }],
  h2: ["clamp(28px, 3vw, 38px)", { lineHeight: "1.1", letterSpacing: "-0.03em", fontWeight: "800" }],
  overline: ["12px", { lineHeight: "1.4", letterSpacing: "0.1em", fontWeight: "800" }],
} as const;
