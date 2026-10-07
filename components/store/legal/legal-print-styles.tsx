/**
 * Print stylesheet for the legal pages (Legal.dc.html @media print): only <main> prints, so the sample strip, header,
 * banner and footer of the store shell are hidden, on a plain background. The page's own navigation hides itself with
 * print:hidden. React hoists and dedupes the <style> by `href`.
 */
const PRINT_CSS = "@media print{[data-store-shell]>:not(main){display:none!important}body{background:none!important}}";

export function LegalPrintStyles() {
  return (
    <style href="axs-legal-print" precedence="default">
      {PRINT_CSS}
    </style>
  );
}
