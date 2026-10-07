import { describe, expect, it } from "vitest";
import {
  allocateByWeight,
  amountInWords,
  buildInvoiceModel,
  indianNumberWords,
  inferGstRatePct,
  invoiceFileName,
  formatOrderDateTime,
  percentLabel,
  readSellerSnapshot,
  type InvoiceModelInput,
} from "@/lib/invoice/model";
import { gstSplit } from "@/lib/pricing";

const SELLER = {
  legalName: "Axiomatic Software Solutions (placeholder)",
  gstin: "27AAAAA0000A1Z5",
  address: "Registered office address (placeholder)",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
  sample: true,
};

const BILLING = {
  name: "Rahul Verma",
  email: "rahul@example.com",
  phone: "9820012345",
  business: "Verma Traders",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
  gstin: null,
};

/** An order like the prototype's: Medical annual ₹4,999 with WELCOME10, intra-state (CGST + SGST). */
function input(over: Partial<InvoiceModelInput> = {}): InvoiceModelInput {
  return {
    orderId: "AX-10301",
    status: "PAID",
    createdAt: "2026-10-06T22:32:00.000Z", // 7 Oct 2026, 4:02 am IST
    invoice: { number: "AXS/26-27/1181", issuedAt: "2026-10-06T22:33:00.000Z" },
    sac: "997331",
    seller: SELLER,
    billing: BILLING,
    placeOfSupply: "Maharashtra",
    couponCode: "WELCOME10",
    totals: {
      subtotalPaise: 499_900,
      discountPaise: 49_990,
      taxablePaise: 449_910,
      cgstPaise: 40_492,
      sgstPaise: 40_492,
      igstPaise: 0,
      totalPaise: 530_894,
    },
    items: [
      {
        productName: "Medical Store Billing Software",
        productShortName: "Medical Store Billing",
        planName: "Annual license",
        kind: "NEW",
        qty: 1,
        unitPricePaise: 499_900,
        discountPaise: 49_990,
        taxablePaise: 449_910,
        taxPaise: 80_984,
        targetLicenseId: null,
      },
    ],
    ...over,
  };
}

describe("indianNumberWords / amountInWords", () => {
  it("uses Indian grouping (thousand, lakh, crore)", () => {
    expect(indianNumberWords(0)).toBe("Zero");
    expect(indianNumberWords(7)).toBe("Seven");
    expect(indianNumberWords(19)).toBe("Nineteen");
    expect(indianNumberWords(40)).toBe("Forty");
    expect(indianNumberWords(98)).toBe("Ninety-Eight");
    expect(indianNumberWords(100)).toBe("One Hundred");
    expect(indianNumberWords(5308)).toBe("Five Thousand Three Hundred Eight");
    expect(indianNumberWords(100_000)).toBe("One Lakh");
    expect(indianNumberWords(250_500)).toBe("Two Lakh Fifty Thousand Five Hundred");
    expect(indianNumberWords(12_345_678)).toBe("One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight");
    expect(indianNumberWords(99_99_99_999)).toBe("Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine");
    expect(indianNumberWords(1_000_000_000)).toBe("One Hundred Crore");
    expect(indianNumberWords(12_50_00_00_000)).toBe("One Thousand Two Hundred Fifty Crore");
  });

  it("writes rupees and paise", () => {
    expect(amountInWords(530_894)).toBe("Rupees Five Thousand Three Hundred Eight and Ninety-Four paise only");
    expect(amountInWords(589_882)).toBe("Rupees Five Thousand Eight Hundred Ninety-Eight and Eighty-Two paise only");
    expect(amountInWords(400_000)).toBe("Rupees Four Thousand only");
    expect(amountInWords(1_18_00_000)).toBe("Rupees One Lakh Eighteen Thousand only");
    expect(amountInWords(100)).toBe("Rupees One only");
    expect(amountInWords(5)).toBe("Rupees Zero and Five paise only");
    expect(amountInWords(0)).toBe("Rupees Zero only");
  });

  it("rejects negative and fractional amounts", () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(1.5)).toThrow(RangeError);
    expect(() => indianNumberWords(Number.NaN)).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("infers the GST rate the totals were computed with", () => {
    for (const taxable of [1, 99, 449_910, 499_900, 123_456_789]) {
      expect(inferGstRatePct(taxable, gstSplit(taxable, 18, true).gstPaise)).toBe(18);
      expect(inferGstRatePct(taxable, gstSplit(taxable, 12, false).gstPaise, 12)).toBe(12);
    }
    expect(inferGstRatePct(0, 0, 18)).toBe(18);
    expect(inferGstRatePct(100_000, 5_000)).toBe(5);
  });

  it("labels rates", () => {
    expect(percentLabel(18)).toBe("18%");
    expect(percentLabel(9)).toBe("9%");
    expect(percentLabel(2.5)).toBe("2.5%");
    expect(percentLabel(0.125)).toBe("0.13%");
  });

  it("allocates by largest remainder so parts add up", () => {
    expect(allocateByWeight(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateByWeight(40_492, [80_984])).toEqual([40_492]);
    expect(allocateByWeight(5, [0, 0])).toEqual([5, 0]);
    expect(allocateByWeight(7, [])).toEqual([]);
    const parts = allocateByWeight(1_234_567, [3, 7, 11, 13]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_234_567);
  });

  it("formats the order date like the prototype (IST, 12-hour)", () => {
    expect(formatOrderDateTime("2026-10-06T22:32:00.000Z")).toBe("7 Oct 2026, 4:02 am");
    expect(formatOrderDateTime(new Date("2026-10-07T09:45:00.000Z"))).toBe("7 Oct 2026, 3:15 pm");
    expect(formatOrderDateTime("2026-10-06T18:30:00.000Z")).toBe("7 Oct 2026, 12:00 am");
    expect(formatOrderDateTime("2026-10-07T06:30:00.000Z")).toBe("7 Oct 2026, 12:00 pm");
  });

  it("reads seller snapshots leniently and names safe PDF files", () => {
    expect(readSellerSnapshot(null)).toEqual({ legalName: "", gstin: "", address: "", city: "", state: "", pin: "", sample: false });
    expect(readSellerSnapshot({ ...SELLER, extra: 1 })).toEqual(SELLER);
    expect(invoiceFileName("AXS/26-27/1181")).toBe("Invoice-AXS-26-27-1181.pdf");
    expect(invoiceFileName("../x\"y")).toBe("Invoice-x-y.pdf");
  });
});

describe("buildInvoiceModel", () => {
  it("builds an intra-state tax invoice (CGST + SGST) like the prototype", () => {
    const m = buildInvoiceModel(input());
    expect(m.isInvoice).toBe(true);
    expect(m.title).toBe("Tax invoice AXS/26-27/1181");
    expect(m.invoiceDate).toBe("7 Oct 2026");
    expect(m.orderDateTime).toBe("7 Oct 2026, 4:02 am");
    expect(m.supply).toBe("intra");
    expect(m.gstRatePct).toBe(18);
    expect(m.placeOfSupplyLabel).toBe("Maharashtra (27)");
    expect(m.seller).toMatchObject({
      name: "Axiomatic Software Solutions",
      gstinLine: "GSTIN 27AAAAA0000A1Z5 (sample)",
      location: "Pune, Maharashtra",
      lines: ["Registered office address (placeholder)", "Pune, Maharashtra 411001"],
      stateCode: "27",
      sample: true,
    });
    expect(m.buyer).toMatchObject({
      name: "Verma Traders",
      attention: "Rahul Verma",
      addressLine: "12 MG Road, Pune, Maharashtra, 411001",
      gstinLine: "Unregistered (no GSTIN)",
    });
    expect(m.totals.map((r) => [r.label, r.display, r.strong])).toEqual([
      ["Subtotal", "₹4,999.00", false],
      ["Discount (WELCOME10)", "−₹499.90", false],
      ["Taxable value", "₹4,499.10", false],
      ["CGST 9%", "₹404.92", false],
      ["SGST 9%", "₹404.92", false],
      ["Total paid", "₹5,308.94", true],
    ]);
    expect(m.amountInWords).toBe("Rupees Five Thousand Three Hundred Eight and Ninety-Four paise only");
    expect(m.lines).toEqual([
      expect.objectContaining({
        index: 1,
        shortName: "Medical Store Billing",
        detail: "Annual license",
        grossPaise: 499_900,
        taxablePaise: 449_910,
        cgstPaise: 40_492,
        sgstPaise: 40_492,
        igstPaise: 0,
        amountPaise: 530_894,
      }),
    ]);
  });

  it("builds an inter-state invoice with IGST and a registered buyer", () => {
    const m = buildInvoiceModel(
      input({
        couponCode: null,
        billing: { ...BILLING, business: null, state: "Karnataka", city: "Bengaluru", pin: "560001", gstin: "29ABCDE1234F1Z5" },
        placeOfSupply: "Karnataka",
        totals: { subtotalPaise: 499_900, discountPaise: 0, taxablePaise: 499_900, cgstPaise: 0, sgstPaise: 0, igstPaise: 89_982, totalPaise: 589_882 },
        items: [{ ...input().items[0]!, discountPaise: 0, taxablePaise: 499_900, taxPaise: 89_982 }],
      }),
    );
    expect(m.supply).toBe("inter");
    expect(m.placeOfSupplyLabel).toBe("Karnataka (29)");
    expect(m.buyer).toMatchObject({ name: "Rahul Verma", attention: null, gstinLine: "GSTIN 29ABCDE1234F1Z5" });
    expect(m.totals.map((r) => r.label)).toEqual(["Subtotal", "Taxable value", "IGST 18%", "Total paid"]);
    expect(m.lines[0]).toMatchObject({ igstPaise: 89_982, cgstPaise: 0, sgstPaise: 0, amountPaise: 589_882 });
  });

  it("allocates the header CGST across lines so every column sums to the header", () => {
    // Two lines whose tax shares are odd: per-line halves would not add up to the header CGST.
    const taxable = [299_901, 149_999];
    const gst = gstSplit(taxable[0]! + taxable[1]!, 18, true);
    const lineTax = [Math.round((gst.gstPaise * taxable[0]!) / (taxable[0]! + taxable[1]!))];
    lineTax.push(gst.gstPaise - lineTax[0]!);
    const m = buildInvoiceModel(
      input({
        couponCode: null,
        totals: {
          subtotalPaise: taxable[0]! + taxable[1]!,
          discountPaise: 0,
          taxablePaise: taxable[0]! + taxable[1]!,
          cgstPaise: gst.cgstPaise,
          sgstPaise: gst.sgstPaise,
          igstPaise: 0,
          totalPaise: taxable[0]! + taxable[1]! + gst.gstPaise,
        },
        items: taxable.map((t, i) => ({
          productName: "Restaurant Billing Software",
          planName: "Per-terminal license",
          kind: "NEW" as const,
          qty: i + 2,
          unitPricePaise: t / (i + 2),
          discountPaise: 0,
          taxablePaise: t,
          taxPaise: lineTax[i]!,
          targetLicenseId: null,
        })),
      }),
    );
    const sum = (k: "cgstPaise" | "sgstPaise" | "taxPaise" | "amountPaise") => m.lines.reduce((a, l) => a + l[k], 0);
    expect(sum("cgstPaise")).toBe(gst.cgstPaise);
    expect(sum("sgstPaise")).toBe(gst.sgstPaise);
    expect(sum("amountPaise")).toBe(m.totalPaise);
    for (const line of m.lines) expect(line.cgstPaise + line.sgstPaise).toBe(line.taxPaise);
    expect(m.lines[0]?.shortName).toBe("Restaurant Billing Software");
    expect(m.lines[1]?.detail).toBe("Per-terminal license × 3");
  });

  it("describes renewals, upgrades and add-ons", () => {
    const base = input().items[0]!;
    const m = buildInvoiceModel(
      input({
        items: [
          { ...base, kind: "RENEWAL", targetLicenseId: "LIC-24017" },
          { ...base, kind: "UPGRADE", targetLicenseId: "LIC-24018", taxPaise: 0 },
          { ...base, kind: "ADDON", planName: "Additional computer", qty: 2, targetLicenseId: "LIC-24019", taxPaise: 0 },
        ],
      }),
    );
    expect(m.lines.map((l) => l.detail)).toEqual([
      "Annual license · Renewal of LIC-24017",
      "Annual license · Upgrade of LIC-24018",
      "Additional computer × 2 · Add-on for LIC-24019",
    ]);
  });

  it("is an order summary before payment, and names the seller once details are real", () => {
    const unpaid = buildInvoiceModel(input({ status: "CONFIRMING", invoice: null }));
    expect(unpaid).toMatchObject({ isInvoice: false, title: "Order summary", number: null, invoiceDate: null, totalLabel: "Total" });
    expect(unpaid.totals.at(-1)).toMatchObject({ label: "Total", display: "₹5,308.94" });

    const real = buildInvoiceModel(input({ seller: { ...SELLER, legalName: "Axiomatic Web Solutions Pvt. Ltd.", sample: false } }));
    expect(real.seller.name).toBe("Axiomatic Web Solutions Pvt. Ltd.");
    expect(real.seller.gstinLine).toBe("GSTIN 27AAAAA0000A1Z5");

    const refunded = buildInvoiceModel(input({ status: "REFUNDED" }));
    expect(refunded).toMatchObject({ isInvoice: true, totalLabel: "Total paid" });
  });
});
