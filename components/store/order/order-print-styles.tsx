/**
 * Print stylesheet of the order page (Order.dc.html @media print): only <main> prints, so the sample strip, header,
 * banner, footer and toasts of the store shell are hidden, on a white page. Buttons, the download rows, next steps and
 * the account prompt hide themselves with print:hidden; license keys print masked. The result is the printable tax
 * invoice. React hoists and dedupes the <style> by `href`.
 */
const PRINT_CSS =
  "@media print{[data-store-shell]>:not(main){display:none!important}body{background:none!important}" +
  "[data-sonner-toaster]{display:none!important}@page{margin:14mm}}";

export function OrderPrintStyles() {
  return (
    <style href="axs-order-print" precedence="default">
      {PRINT_CSS}
    </style>
  );
}
