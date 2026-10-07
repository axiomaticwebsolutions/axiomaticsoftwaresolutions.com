/**
 * Invoice and credit-note numbers for the sample orders (docs/decisions.md 4): one gap-free sequence per Indian
 * financial year (IST), assigned in paidAt order. The current FY ends at 1180 so real invoices continue at 1181.
 * Earlier FYs keep the prototype's portal numbers where possible (AX-10198 = 1104, AX-10102 = 0988).
 */
import { fiscalYearLabel } from "@/lib/dates";

export const CURRENT_FY_LAST_INVOICE = 1180;

/** Prototype invoice numbers of the portal sample orders, honoured when their FY is not the current one. */
export const INVOICE_ANCHORS: Readonly<Record<string, number>> = { "AX-10198": 1104, "AX-10102": 988 };

export type NumberingEntry = { orderId: string; at: Date };

export type NumberingPlan = {
  /** orderId -> document number. */
  numbers: Map<string, string>;
  /** FY label -> the value Counter.next must hold (last assigned + 1). */
  next: Map<string, number>;
};

/** "AXS/26-27/1181" */
export function documentNumber(prefix: string, fy: string, n: number): string {
  return `${prefix}/${fy}/${String(n).padStart(4, "0")}`;
}

function groupByFy(entries: readonly NumberingEntry[]): Map<string, NumberingEntry[]> {
  const seen = new Set<string>();
  const groups = new Map<string, NumberingEntry[]>();
  for (const entry of entries) {
    if (seen.has(entry.orderId)) throw new RangeError(`Duplicate numbering entry for ${entry.orderId}`);
    seen.add(entry.orderId);
    const fy = fiscalYearLabel(entry.at);
    const group = groups.get(fy) ?? [];
    group.push(entry);
    groups.set(fy, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.at.getTime() - b.at.getTime() || a.orderId.localeCompare(b.orderId));
  }
  return groups;
}

/** Tax invoice numbers. Every FY is contiguous; the FY containing `now` ends at `currentFyLast`. */
export function planInvoiceNumbers(
  entries: readonly NumberingEntry[],
  opts: { prefix: string; now: Date; currentFyLast?: number; anchors?: Readonly<Record<string, number>> },
): NumberingPlan {
  const currentFy = fiscalYearLabel(opts.now);
  const currentFyLast = opts.currentFyLast ?? CURRENT_FY_LAST_INVOICE;
  const anchors = opts.anchors ?? INVOICE_ANCHORS;
  const plan: NumberingPlan = { numbers: new Map(), next: new Map() };

  for (const [fy, group] of groupByFy(entries)) {
    let first: number;
    if (fy === currentFy) {
      first = currentFyLast - group.length + 1;
      if (first < 1) throw new RangeError(`More than ${currentFyLast} sample invoices in FY ${fy}`);
    } else {
      // First number implied by the earliest anchored order in this FY (its number minus its position).
      const implied = group.flatMap((e, i) => {
        const anchor = anchors[e.orderId];
        return anchor === undefined ? [] : [anchor - i];
      })[0];
      first = implied !== undefined && implied >= 1 ? implied : 1;
    }
    group.forEach((entry, i) => plan.numbers.set(entry.orderId, documentNumber(opts.prefix, fy, first + i)));
    plan.next.set(fy, first + group.length);
  }
  if (!plan.next.has(currentFy)) plan.next.set(currentFy, currentFyLast + 1);
  return plan;
}

/** Credit-note numbers: per FY of the refund date, from 0001 in date order. */
export function planCreditNoteNumbers(entries: readonly NumberingEntry[], prefix: string): NumberingPlan {
  const plan: NumberingPlan = { numbers: new Map(), next: new Map() };
  for (const [fy, group] of groupByFy(entries)) {
    group.forEach((entry, i) => plan.numbers.set(entry.orderId, documentNumber(prefix, fy, i + 1)));
    plan.next.set(fy, group.length + 1);
  }
  return plan;
}
