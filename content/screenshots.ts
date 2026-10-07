/**
 * Product page screenshot placeholders (docs/decisions.md > Phase 2: HTML-rendered placeholder panels until real
 * screenshots exist). Copy is verbatim from design_handoff_axiomatic/prototype/Product.dc.html. Each product has up
 * to three tabs; every panel is labelled "Placeholder screenshot". Edit freely: the product page renders whatever is
 * here, and products without an entry get a generic panel built from their features
 * (components/store/product/model.ts > screenshotsFor). Pure data, client-safe.
 */

/** Value colour: warn (peach), danger (pink), ok (sage); default ink. */
export type ScreenshotValueTone = "warn" | "danger" | "ok";

export type ScreenshotRow = {
  label: string;
  value: string;
  tone?: ScreenshotValueTone;
};

export type ProductScreenshot = {
  /** Tab label under the panel, also listed in the panel's side navigation. */
  tab: string;
  /** Window title after the product's short name: "Medical Store Billing — Counter billing". */
  title: string;
  heading: string;
  rows: readonly ScreenshotRow[];
  /** Footer pair under the dashed divider, e.g. ["Total", "₹312.40"]. */
  foot: readonly [string, string];
};

/** Side navigation entries after the tab labels (not selectable). */
export const SCREENSHOT_EXTRA_NAV = ["Reports", "Settings"] as const;

/** Visible badge on every panel (the screenshots are illustrative, not real UI). */
export const SCREENSHOT_BADGE = "Placeholder screenshot";

const row = (label: string, value: string, tone?: ScreenshotValueTone): ScreenshotRow =>
  tone ? { label, value, tone } : { label, value };

/** By product slug. */
export const PRODUCT_SCREENSHOTS: Readonly<Record<string, readonly ProductScreenshot[]>> = {
  "medical-billing": [
    {
      tab: "Billing",
      title: "Counter billing",
      heading: "Bill #B-2291",
      rows: [
        row("Paracetamol 650 mg · B2304", "₹62.00"),
        row("Cetirizine 10 mg · exp 11/26", "₹18.50", "warn"),
        row("ORS sachets × 4", "₹84.00"),
        row("Vitamin D3 60K", "₹126.00"),
        row("GST (CGST + SGST)", "₹21.90"),
      ],
      foot: ["Total", "₹312.40"],
    },
    {
      tab: "Expiry",
      title: "Expiry watch",
      heading: "Expiring in 60 days",
      rows: [
        row("Amoxicillin 500 · B1182", "12 strips"),
        row("Azithromycin 250 · B0941", "6 strips"),
        row("Cough syrup 100 ml · C220", "9 bottles"),
        row("Insulin pen · I5571", "2 units", "danger"),
      ],
      foot: ["Return value", "₹4,860.00"],
    },
    {
      tab: "Purchases",
      title: "Purchase entry",
      heading: "Shree Distributors",
      rows: [
        row("Invoice SD/8841", "₹18,240.00"),
        row("Items received", "42"),
        row("Credit days", "30"),
        row("Outstanding", "₹6,400.00", "warn"),
      ],
      foot: ["Due", "28 Oct"],
    },
  ],
  "restaurant-billing": [
    {
      tab: "Tables",
      title: "Floor view",
      heading: "Table 6 · 4 guests",
      rows: [
        row("Paneer tikka × 1", "₹280.00"),
        row("Butter naan × 4", "₹160.00"),
        row("Dal makhani × 1", "₹240.00"),
        row("Masala chai × 2", "₹80.00"),
        row("KOT #118 sent", "Kitchen", "ok"),
      ],
      foot: ["Running total", "₹760.00"],
    },
    {
      tab: "KOT",
      title: "Kitchen tickets",
      heading: "Open KOTs",
      rows: [row("#118 · Table 6", "4 items"), row("#119 · Takeaway", "2 items"), row("#120 · Table 2", "5 items", "warn")],
      foot: ["Avg. prep", "14 min"],
    },
    {
      tab: "Day end",
      title: "Day-end report",
      heading: "Today",
      rows: [row("Bills", "86"), row("UPI", "₹21,450.00"), row("Card", "₹9,320.00"), row("Cash", "₹7,180.00")],
      foot: ["Net sales", "₹37,950.00"],
    },
  ],
  "general-store-gst": [
    {
      tab: "Invoice",
      title: "Tax invoice",
      heading: "INV/1182 · B2B",
      rows: [
        row("Basmati rice 5 kg × 2", "₹1,040.00"),
        row("Sunflower oil 1 L × 3", "₹435.00"),
        row("Toor dal 1 kg × 2", "₹318.00"),
        row("Detergent 1 kg × 1", "₹210.00"),
        row("CGST + SGST", "₹141.10"),
      ],
      foot: ["Total", "₹2,003.00"],
    },
    {
      tab: "Stock",
      title: "Stock",
      heading: "Low stock",
      rows: [row("Sugar 1 kg", "6 left", "danger"), row("Tea 500 g", "11 left"), row("Atta 10 kg", "4 left", "danger")],
      foot: ["Reorder value", "₹9,420.00"],
    },
    {
      tab: "Credit",
      title: "Customer credit",
      heading: "Outstanding",
      rows: [row("R. Kulkarni", "₹2,140.00"), row("S. Banerjee", "₹860.00"), row("M. Qureshi", "₹1,320.00", "warn")],
      foot: ["Total due", "₹4,320.00"],
    },
  ],
  "cheque-printing": [
    {
      tab: "Print",
      title: "Print cheque",
      heading: "Pay: Shree Distributors",
      rows: [
        row("Amount", "₹24,500.00"),
        row("In words", "Twenty-four thousand five hundred"),
        row("Date", "06-10-2026"),
        row("Crossing", "A/C payee"),
      ],
      foot: ["Layout", "Saved"],
    },
    {
      tab: "Register",
      title: "Cheque register",
      heading: "October",
      rows: [
        row("000214 · Shree Distributors", "Printed"),
        row("000215 · City Power", "Cleared", "ok"),
        row("000216 · Landlord (PDC)", "Due 01 Nov", "warn"),
      ],
      foot: ["Issued", "₹1,12,300.00"],
    },
    {
      tab: "Layouts",
      title: "Layout designer",
      heading: "Bank layouts",
      rows: [row("Current account", "Default"), row("Savings account", "Saved"), row("Offset", "+1.5 mm")],
      foot: ["Layouts", "2"],
    },
  ],
};
