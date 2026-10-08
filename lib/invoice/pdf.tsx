/**
 * Tax invoice and credit note PDF (A4) rendered with @react-pdf/renderer from the shared invoice model
 * (lib/invoice/model.ts), in the look of the order page's printable invoice. Labels come from the model (docLabel,
 * numberLabel, dateLabel, reference, extraNotes), so a credit note is the same document with its own wording. Server-only (Node): fonts are read from node_modules/@fontsource.
 *
 * Fonts: Manrope 400/600/700/800 and JetBrains Mono 400, each registered twice, from the `latin` and the
 * `latin-ext` subsets, as two families listed together (fontFamily: [main, ext]). react-pdf substitutes per code
 * point, so the rupee sign (U+20B9, only in latin-ext) renders in Manrope instead of falling back to Helvetica.
 * Colours come from lib/design/tokens.ts.
 */
import "server-only";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import {
  Document,
  Font,
  Page,
  Path,
  Rect,
  renderToBuffer,
  StyleSheet,
  Svg,
  Text,
  View,
  type DocumentProps,
} from "@react-pdf/renderer";
import { palette, tones } from "@/lib/design/tokens";
import { formatINR } from "@/lib/money";
import type { InvoiceLine, InvoiceModel } from "./model";

const SANS = "Manrope";
const SANS_EXT = "Manrope Ext";
const MONO = "JetBrains Mono";
const MONO_EXT = "JetBrains Mono Ext";
const SANS_FAMILY = [SANS, SANS_EXT];
const MONO_FAMILY = [MONO, MONO_EXT];
const SANS_WEIGHTS = [400, 600, 700, 800] as const;

let fontsRegistered = false;

function fontFile(pkg: "manrope" | "jetbrains-mono", subset: "latin" | "latin-ext", weight: number): string {
  const file = join(process.cwd(), "node_modules", "@fontsource", pkg, "files", `${pkg}-${subset}-${weight}-normal.woff`);
  if (!existsSync(file)) throw new Error(`Invoice font missing: @fontsource/${pkg} ${subset} ${weight}`);
  return file;
}

/** Registers the invoice fonts once per process (idempotent). */
export function registerInvoiceFonts(): void {
  if (fontsRegistered) return;
  Font.register({ family: SANS, fonts: SANS_WEIGHTS.map((w) => ({ src: fontFile("manrope", "latin", w), fontWeight: w })) });
  Font.register({ family: SANS_EXT, fonts: SANS_WEIGHTS.map((w) => ({ src: fontFile("manrope", "latin-ext", w), fontWeight: w })) });
  Font.register({ family: MONO, src: fontFile("jetbrains-mono", "latin", 400), fontWeight: 400 });
  Font.register({ family: MONO_EXT, src: fontFile("jetbrains-mono", "latin-ext", 400), fontWeight: 400 });
  // Never hyphenate names, GSTINs or invoice numbers.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

const C = {
  ink: palette.ink.DEFAULT,
  ink2: palette.ink["2"],
  soft: palette.ink.soft,
  line: palette.line.DEFAULT,
  subtle: palette.line.subtle,
  bg: palette.bg.DEFAULT,
  primary: palette.primary.DEFAULT,
  white: palette.surface,
  accent: palette.brand["mark-accent"],
  lavender: tones.lavender.bg,
  lavenderFg: tones.lavender.fg,
  peach: tones.peach.bg,
  peachInk: palette.notice.ink,
};

/**
 * No ligatures (inherited by every Text). Manrope's fi/ff/tt ligature glyphs get multi-character ToUnicode entries
 * (`<0066 0069>`), which some PDF readers' text layers cut to the first character: copy, search and screen readers
 * would read "ofice", "Atn" or a wrong email. One glyph per character keeps the text layer exact.
 */
export const INVOICE_FONT_FEATURES = { liga: false, clig: false } as const;

const s = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 56,
    paddingHorizontal: 40,
    fontFamily: SANS_FAMILY,
    fontSize: 9,
    color: C.ink,
    fontFeatureSettings: INVOICE_FONT_FEATURES,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  brand: { flexDirection: "row", alignItems: "center" },
  brandText: { marginLeft: 8 },
  brandName: { fontSize: 15, fontWeight: 800, letterSpacing: -0.3, lineHeight: 1 },
  brandSub: { marginTop: 3, fontSize: 5.8, fontWeight: 700, letterSpacing: 1.2, color: C.ink2 },
  titleBlock: { alignItems: "flex-end" },
  title: { fontSize: 17, fontWeight: 800, letterSpacing: -0.3, lineHeight: 1.2 },
  titleSub: { marginTop: 2, fontSize: 8, color: C.ink2, fontWeight: 600 },
  sampleBanner: { marginTop: 14, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: C.peach, color: C.peachInk, fontSize: 8, fontWeight: 600 },
  meta: { marginTop: 16, flexDirection: "row", borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line, paddingVertical: 10 },
  metaCell: { flex: 1, paddingRight: 8 },
  overline: { fontSize: 6.5, fontWeight: 800, letterSpacing: 0.8, color: C.ink2, marginBottom: 3 },
  metaValue: { fontSize: 9.5, fontWeight: 700 },
  parties: { marginTop: 14, flexDirection: "row" },
  party: { flex: 1, padding: 12, borderWidth: 1, borderColor: C.line, borderRadius: 8 },
  partyGap: { width: 12 },
  partyName: { fontSize: 10.5, fontWeight: 800, marginBottom: 2 },
  // react-pdf resolves a unitless lineHeight against the same style’s fontSize (18 when unset), so set both.
  partyLine: { color: C.soft, fontSize: 9, lineHeight: 1.45 },
  mono: { fontFamily: MONO_FAMILY, fontSize: 8.5, letterSpacing: 0.2 },
  table: { marginTop: 16, borderWidth: 1, borderColor: C.line, borderRadius: 8 },
  thead: { flexDirection: "row", backgroundColor: C.bg, borderBottomWidth: 1, borderColor: C.line, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  th: { paddingVertical: 6, paddingHorizontal: 4, fontSize: 6.8, fontWeight: 800, letterSpacing: 0.4, color: C.ink2 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderColor: C.subtle },
  trLast: { flexDirection: "row" },
  td: { paddingVertical: 7, paddingHorizontal: 4, fontSize: 8, lineHeight: 1.35 },
  tdStrong: { fontWeight: 700 },
  tdNote: { marginTop: 1.5, fontSize: 7, color: C.ink2, lineHeight: 1.35 },
  summary: { marginTop: 14, flexDirection: "row", alignItems: "flex-start" },
  words: { flex: 1, marginRight: 18, padding: 10, borderRadius: 8, backgroundColor: C.bg },
  wordsText: { fontSize: 8.5, fontWeight: 600, lineHeight: 1.45 },
  totals: { width: 220 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  totalLabel: { color: C.ink2, fontWeight: 600 },
  totalValue: { fontWeight: 600 },
  grandRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, paddingTop: 7, borderTopWidth: 1, borderColor: C.line },
  grandText: { fontSize: 11, fontWeight: 800 },
  notes: { marginTop: 22, paddingTop: 10, borderTopWidth: 1, borderColor: C.subtle },
  note: { fontSize: 7.5, color: C.ink2, marginBottom: 2, lineHeight: 1.4 },
  footer: { position: "absolute", left: 40, right: 40, bottom: 24, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: C.ink2 },
});

// Written with createElement (h) rather than JSX syntax: Vitest compiles with the project tsconfig ("jsx": "preserve",
// which Next needs), so JSX in a module that DB tests import would not parse there.
const h = createElement;

type Column = {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right";
  cell: (line: InvoiceLine, model: InvoiceModel) => ReactNode;
};

const money = (paise: number) => formatINR(paise, { exact: true });
const right = { textAlign: "right" as const };

function columnsFor(model: InvoiceModel): Column[] {
  const tax: Column[] =
    model.supply === "inter"
      ? [{ key: "igst", label: `IGST ${model.rateLabel}`, width: 58, align: "right", cell: (l) => money(l.igstPaise) }]
      : [
          { key: "cgst", label: `CGST ${model.halfRateLabel}`, width: 50, align: "right", cell: (l) => money(l.cgstPaise) },
          { key: "sgst", label: `SGST ${model.halfRateLabel}`, width: 50, align: "right", cell: (l) => money(l.sgstPaise) },
        ];
  return [
    { key: "index", label: "#", width: 16, cell: (l) => String(l.index) },
    {
      key: "description",
      label: "DESCRIPTION",
      cell: (l) => [
        h(Text, { key: "p", style: s.tdStrong }, l.productName),
        h(Text, { key: "n", style: s.tdNote }, l.kindNote ? `${l.planName} · ${l.kindNote}` : l.planName),
      ],
    },
    { key: "sac", label: "SAC", width: 38, cell: (_l, m) => m.sac },
    { key: "qty", label: "QTY", width: 24, align: "right", cell: (l) => String(l.qty) },
    { key: "rate", label: "UNIT PRICE", width: 56, align: "right", cell: (l) => money(l.unitPricePaise) },
    { key: "discount", label: "DISCOUNT", width: 48, align: "right", cell: (l) => (l.discountPaise > 0 ? `−${money(l.discountPaise)}` : "—") },
    { key: "taxable", label: "TAXABLE VALUE", width: 58, align: "right", cell: (l) => money(l.taxablePaise) },
    ...tax,
    { key: "amount", label: "AMOUNT", width: 58, align: "right", cell: (l) => h(Text, { style: [s.tdStrong, right] }, money(l.amountPaise)) },
  ];
}

function cellStyle(col: Column) {
  return [col.width ? { width: col.width } : { flex: 1 }, col.align === "right" ? right : {}];
}

function cellContent(content: ReactNode, align: Column["align"]): ReactNode {
  return typeof content === "string" ? h(Text, { style: align === "right" ? right : {} }, content) : content;
}

function LogoMark() {
  return h(
    Svg,
    { width: 28, height: 28, viewBox: "0 0 32 32" },
    h(Rect, { width: 32, height: 32, rx: 9, fill: C.primary }),
    h(Path, { d: "M8.6 23.6 16 8.4l7.4 15.2", fill: "none", stroke: C.white, strokeWidth: 3.1, strokeLinecap: "round", strokeLinejoin: "round" }),
    h(Path, { d: "M13.6 18.4h10", stroke: C.accent, strokeWidth: 3.1, strokeLinecap: "round" }),
  );
}

type PartyProps = { label: string; name: string; lines: string[]; gstin: string; extra?: string[] };

function Party({ label, name, lines, gstin, extra = [] }: PartyProps) {
  return h(
    View,
    { style: s.party },
    h(Text, { style: s.overline }, label),
    h(Text, { style: s.partyName }, name),
    ...lines.map((line, i) => h(Text, { key: `l${i}`, style: s.partyLine }, line)),
    h(Text, { style: [s.partyLine, s.mono, { marginTop: 3 }] }, gstin),
    ...extra.map((line, i) => h(Text, { key: `x${i}`, style: s.partyLine }, line)),
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return h(View, { style: s.metaCell }, h(Text, { style: s.overline }, label), h(Text, { style: s.metaValue }, value));
}

function LinesTable({ model }: { model: InvoiceModel }) {
  const columns = columnsFor(model);
  const head = h(
    View,
    { style: s.thead, fixed: true },
    ...columns.map((col) => h(Text, { key: col.key, style: [s.th, ...cellStyle(col)] }, col.label)),
  );
  const rows = model.lines.map((line, i) =>
    h(
      View,
      { key: line.index, style: i === model.lines.length - 1 ? s.trLast : s.tr, wrap: false },
      ...columns.map((col) => h(View, { key: col.key, style: [s.td, ...cellStyle(col)] }, cellContent(col.cell(line, model), col.align))),
    ),
  );
  return h(View, { style: s.table }, head, ...rows);
}

function Summary({ model }: { model: InvoiceModel }) {
  const rows = model.totals
    .filter((row) => !row.strong)
    .map((row) =>
      h(View, { key: row.key, style: s.totalRow }, h(Text, { style: s.totalLabel }, row.label), h(Text, { style: s.totalValue }, row.display)),
    );
  return h(
    View,
    { style: s.summary, wrap: false },
    h(View, { style: s.words }, h(Text, { style: s.overline }, "AMOUNT IN WORDS"), h(Text, { style: s.wordsText }, model.amountInWords)),
    h(
      View,
      { style: s.totals },
      ...rows,
      h(View, { style: s.grandRow }, h(Text, { style: s.grandText }, model.totalLabel), h(Text, { style: s.grandText }, money(model.totalPaise))),
    ),
  );
}

function Notes({ model }: { model: InvoiceModel }) {
  const supply =
    model.supply === "inter"
      ? `Inter-state supply: IGST ${model.rateLabel}.`
      : `Intra-state supply: CGST ${model.halfRateLabel} + SGST ${model.halfRateLabel}.`;
  return h(
    View,
    { style: s.notes, wrap: false },
    h(Text, { style: s.note }, `${supply} SAC ${model.sac}. Tax is not payable on reverse charge.`),
    h(Text, { style: s.note }, `Amounts are in Indian rupees (INR). Order placed on ${model.orderDateTime} IST.`),
    ...model.extraNotes.map((note, i) => h(Text, { key: `x${i}`, style: s.note }, note)),
    h(
      Text,
      { style: s.note },
      `This is a computer-generated ${model.kind === "credit_note" ? "credit note" : "invoice"} and does not need a signature.`,
    ),
  );
}

const SAMPLE_NOTICE =
  "Sample seller details: the seller’s legal name, GSTIN and address are placeholders, so this is not a valid tax invoice.";

/** The invoice document. Long orders continue on new pages; the table header and the footer repeat. */
export function InvoiceDocument({ model }: { model: InvoiceModel }) {
  const number = model.number ?? model.orderId;
  const buyerExtra = [
    ...(model.buyer.attention ? [`Attn: ${model.buyer.attention}`] : []),
    ...[model.buyer.email, model.buyer.phone].filter((v) => v !== ""),
  ];
  const header = h(
    View,
    { style: s.header },
    h(
      View,
      { style: s.brand },
      h(LogoMark),
      h(View, { style: s.brandText }, h(Text, { style: s.brandName }, "Axiomatic"), h(Text, { style: s.brandSub }, "SOFTWARE SOLUTIONS")),
    ),
    h(View, { style: s.titleBlock }, h(Text, { style: s.title }, model.docLabel), h(Text, { style: s.titleSub }, "Original for recipient")),
  );
  const meta = h(
    View,
    { style: s.meta },
    h(MetaCell, { label: model.numberLabel, value: number }),
    h(MetaCell, { label: model.dateLabel, value: model.invoiceDate ?? model.orderDate }),
    ...(model.reference ? [h(MetaCell, { key: "ref", label: model.reference.label, value: model.reference.value })] : []),
    h(MetaCell, { label: "ORDER", value: model.orderId }),
    h(MetaCell, { label: "PLACE OF SUPPLY", value: model.placeOfSupplyLabel }),
  );
  const parties = h(
    View,
    { style: s.parties },
    h(Party, { label: "SOLD BY", name: model.seller.name, lines: model.seller.lines, gstin: model.seller.gstinLine }),
    h(View, { style: s.partyGap }),
    h(Party, { label: "BILLED TO", name: model.buyer.name, lines: model.buyer.lines, gstin: model.buyer.gstinLine, extra: buyerExtra }),
  );
  const footer = h(
    View,
    { style: s.footer, fixed: true },
    h(Text, null, `${model.seller.name} · ${model.docLabel} ${number}`),
    h(Text, { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}` }),
  );
  return h(
    Document,
    {
      title: `${model.docLabel} ${number}`,
      author: model.seller.name,
      creator: model.seller.name,
      producer: model.seller.name,
      subject: `Order ${model.orderId}`,
      language: "en-IN",
    },
    h(
      Page,
      { size: "A4", style: s.page },
      header,
      model.seller.sample ? h(Text, { style: s.sampleBanner }, SAMPLE_NOTICE) : null,
      meta,
      parties,
      h(LinesTable, { model }),
      h(Summary, { model }),
      h(Notes, { model }),
      footer,
    ),
  );
}

/** Renders the invoice PDF (bytes starting with "%PDF-"). */
export async function renderInvoicePdf(model: InvoiceModel): Promise<Buffer> {
  registerInvoiceFonts();
  return renderToBuffer(h(InvoiceDocument, { model }) as ReactElement<DocumentProps>);
}
