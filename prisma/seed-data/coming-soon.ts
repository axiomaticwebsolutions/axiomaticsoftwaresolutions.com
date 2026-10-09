/**
 * The COMING_SOON catalog (decisions.md 2026-10-09 "Coming soon products"): 20 products from the October 2026 market
 * research, listed on the storefront with a "Notify me when it launches" form but not sold. They have no plans,
 * releases or FAQs yet; Windows only; demo requests off. Copy is plain and says what the software WILL do: no prices,
 * dates or competitor names. The owner edits it in Admin > Products & categories.
 *
 * Written by the dev seed (prisma/seed-data/plan.ts) and, on production, once by the versioned catalog addition
 * "2026-10-09-coming-soon" (prisma/seed-data/additions.ts) of the production bootstrap.
 * Every icon (product and feature) is in the app's icon registry (tests/unit/seed-data.test.ts).
 */
import type { Prisma } from "@/generated/prisma/client";
import { PublishStatus } from "@/generated/prisma/enums";
import { productContentSchema, type ProductContent } from "@/lib/catalog/content";
import { startOfDayIST } from "@/lib/dates";
import type { Platform } from "./catalog";
import type { WithId } from "./types";

export type SeedComingSoonProduct = {
  id: string;
  /** License key prefix (^[A-Z]{3}$), unique across the catalog. */
  code: string;
  name: string;
  shortName: string;
  categoryId: string;
  icon: string;
  /** After the published products (ranks 1-4): 101, 102, ... in research order. */
  rank: number;
  /** IST calendar date the product was added; becomes Product.createdAt. */
  added: string;
  tagline: string;
  summary: string;
  platforms: Platform[];
  content: ProductContent;
  relatedIds: string[];
};

type Triple = readonly [string, string, string];
type Pair = readonly [string, string];

/** The day the coming-soon catalog was added (IST). */
export const COMING_SOON_ADDED = "2026-10-09";
const FIRST_RANK = 101;

type Input = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  categoryId: string;
  icon: string;
  tagline: string;
  summary: string;
  features: readonly Triple[];
  benefits: readonly Pair[];
  /** Requirement rows after the operating system, before the internet row. */
  extra?: readonly Pair[];
  /** The internet row, when a feature needs a connection beyond activation and updates (SMS, WhatsApp, email). */
  internet?: string;
  printers: string;
  relatedIds: string[];
};

const OPERATING_SYSTEM: Pair = ["Operating system", "Windows 10 or 11 (64-bit)"];
/** The usual internet row; a product whose features send messages overrides it (Input.internet). */
const OFFLINE_INTERNET = "Needed only to activate and get updates; daily work runs offline";

function define(list: readonly Input[]): SeedComingSoonProduct[] {
  return list.map((p, i) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    categoryId: p.categoryId,
    icon: p.icon,
    rank: FIRST_RANK + i,
    added: COMING_SOON_ADDED,
    tagline: p.tagline,
    summary: p.summary,
    platforms: ["windows"],
    content: {
      features: p.features.map(([icon, title, body]) => ({ icon, title, body })),
      benefits: p.benefits.map(([title, body]) => ({ title, body })),
      requirements: [
        OPERATING_SYSTEM,
        ...(p.extra ?? []),
        ["Internet", p.internet ?? OFFLINE_INTERNET] as Pair,
        ["Printers", p.printers] as Pair,
      ].map(([label, value]) => ({ label, value })),
    },
    relatedIds: [...p.relatedIds],
  }));
}

export const COMING_SOON_PRODUCTS: readonly SeedComingSoonProduct[] = define([
  {
    id: "jewellery-billing",
    code: "JWL",
    name: "Jewellery Shop Billing Software",
    shortName: "Jewellery Shop Billing",
    categoryId: "jewellery",
    icon: "diamond",
    tagline: "Weight-based billing with daily gold rates, HUID and tags for jewellers.",
    summary:
      "Billing software for gold and silver jewellers. It will work out each bill from the day’s rate, net weight, making charges and wastage, and keep HUID and tag records for every piece.",
    features: [
      ["payments", "Daily metal rates", "Enter the day’s gold and silver rate for each purity once, and every bill will use it."],
      ["scale", "Weight and making charges", "Gross, stone and net weight to three decimals, with making charges per gram, as a percentage or fixed, and wastage."],
      ["verified", "HUID for every piece", "Record the HUID of each hallmarked piece and print it on the invoice."],
      ["label", "Tags and barcodes", "Print tag labels, bill by scanning them, and see stock by weight and by pieces."],
      ["currency_exchange", "Old gold exchange", "Buy old gold against a sale on the same bill, with a purity deduction."],
      ["account_balance_wallet", "Advances and savings schemes", "Track advance bookings, rate-locked orders and monthly gold savings schemes."],
      ["swap_horiz", "Karigar register", "Issue metal to karigars and record what comes back, with a fine-weight balance for each."],
    ],
    benefits: [
      ["Correct bills at the counter", "Rates, weights and charges will be worked out the same way on every bill."],
      ["HUID records in one place", "Find any piece by its HUID or tag when a customer asks."],
      ["Metal stock you can check", "Match gold and silver stock by weight at the end of each day."],
    ],
    printers: "Thermal or A4 for invoices; a barcode label printer for tags",
    relatedIds: ["barcode-mrp-labels"],
  },
  {
    id: "pharma-distribution",
    code: "PHD",
    name: "Pharma Distribution Software",
    shortName: "Pharma Distribution",
    categoryId: "pharmacy",
    icon: "medical_services",
    tagline: "Batch-wise billing, schemes and outstanding for pharma stockists.",
    summary:
      "Distribution software for pharma stockists, C&F agents and wholesale chemists. It will handle batch and expiry stock, PTR and PTS rates, schemes, expiry returns and salesman-wise outstanding.",
    features: [
      ["inventory_2", "Batch and expiry stock", "Stock by batch, expiry and MRP, with the earliest-expiring batch picked first and near-expiry alerts while billing."],
      ["sell", "PTR, PTS and schemes", "Separate PTR, PTS and MRP rates, schemes such as 10+1 free, and party-wise price lists."],
      ["badge", "Licence details on invoices", "Each party’s drug licence numbers and GSTIN on the invoice, and the Schedule H and H1 registers."],
      ["undo", "Expiry and breakage returns", "Take returns from retailers, claim them from companies and C&F agents, and raise credit and debit notes."],
      ["route", "Salesmen, beats and routes", "Book orders and bill by salesman, beat and route, with a credit limit for each party."],
      ["account_balance_wallet", "Bill-wise outstanding", "See what each party owes, bill by bill, with ageing."],
      ["upload", "Purchase file import", "Import supplier purchase files from CSV or Excel so purchases need not be typed again."],
    ],
    benefits: [
      ["Less money lost to expiry", "Near-expiry stock will show up while there is still time to sell or return it."],
      ["Faster dispatch", "Keyboard-first billing for long invoices with many batches."],
      ["Collections under control", "Salesman-wise outstanding helps you follow up on time."],
    ],
    printers: "Dot-matrix, A4 or A5 for invoices",
    relatedIds: ["medical-billing", "fmcg-distribution"],
  },
  {
    id: "hardware-billing",
    code: "HWS",
    name: "Hardware & Paint Shop Billing Software",
    shortName: "Hardware & Paint Shop Billing",
    categoryId: "retail",
    icon: "hardware",
    tagline: "Billing with units, quotations and contractor accounts for hardware shops.",
    summary:
      "Billing software for hardware, electrical, sanitary, paint and tile shops. It will handle multiple units, large item lists, quotations, delivery challans and contractor accounts.",
    features: [
      ["tune", "Multiple units", "Sell by box or piece, square foot or metre, litre, kilo, bundle or feet, with the conversions done for you."],
      ["manage_search", "Large item lists", "Find items by brand, size and finish quickly, even with thousands of items."],
      ["description", "Quotation to invoice", "Turn a quotation into an invoice and a delivery challan, including part deliveries."],
      ["account_balance_wallet", "Credit and contractor accounts", "Keep udhaar accounts, and track commission for contractors, plumbers, electricians and painters."],
      ["sell", "Rates by customer type", "Separate rate lists for retail customers, contractors and dealers."],
      ["palette", "Tile and paint details", "Work out boxes from square feet for tiles, and keep tint and shade records for paint."],
      ["verified_user", "Serial and warranty tracking", "Record serial numbers for fans, pumps and inverters, and check warranty from the bill date."],
    ],
    benefits: [
      ["Quick quotes for contractors", "Price a whole job and turn it into a bill once the order is confirmed."],
      ["No mistakes in units", "Box, piece and area conversions will be done by the software, not by hand."],
      ["Know who owes you", "Contractor and customer credit in one ledger."],
    ],
    printers: "Thermal, A5 or A4",
    relatedIds: ["general-store-gst", "barcode-mrp-labels"],
  },
  {
    id: "fmcg-distribution",
    code: "FMC",
    name: "FMCG Distribution Software",
    shortName: "FMCG Distribution",
    categoryId: "wholesale",
    icon: "package_2",
    tagline: "Beat-wise orders, schemes and collections for FMCG and grocery distributors.",
    summary:
      "Distribution software for FMCG, grocery, confectionery and stationery stockists. It will handle case and piece units, schemes, beat-wise order booking, van sales and collections.",
    features: [
      ["inventory", "Cases, boxes and pieces", "Bill in any unit, with free-quantity, slab and combo schemes, and claims on company schemes."],
      ["sell", "Party-wise rates", "Price lists by party or customer type, with trade and cash discounts."],
      ["route", "Beats and salesmen", "Book orders by beat, route and salesman, print loading sheets and settle van sales."],
      ["payments", "Collections and cheques", "Collections by salesman, post-dated cheques and credit limits, with outstanding ageing."],
      ["warehouse", "Godown-wise stock", "Stock in each godown, with damage and expiry returns."],
      ["receipt_long", "E-invoice and e-way bill", "Prepare e-invoice and e-way bill data for larger dispatches, and export sales for GSTR-1."],
    ],
    benefits: [
      ["Orders in by the evening", "Beat-wise booking and loading sheets keep dispatch moving."],
      ["Schemes worked out correctly", "Free quantities and discounts will be applied by the software, not by hand."],
      ["Cash and cheques accounted for", "See what each salesman collected and what is still due."],
    ],
    printers: "Dot-matrix, A4 or A5",
    relatedIds: ["general-store-gst", "cheque-printing", "pharma-distribution"],
  },
  {
    id: "auto-parts-garage",
    code: "AUT",
    name: "Auto Parts & Garage Software",
    shortName: "Auto Parts & Garage",
    categoryId: "retail",
    icon: "car_repair",
    tagline: "Part-number billing, vehicle fit search and job cards for parts shops.",
    summary:
      "Billing software for spare-parts shops, battery and tyre dealers and garages. It will find parts by number or vehicle, track serials and warranties, and run job cards from estimate to invoice.",
    features: [
      ["manage_search", "Part numbers and alternates", "Search by part number, with OEM and aftermarket cross-references and suggested alternates."],
      ["search", "Parts by vehicle", "Find parts by vehicle make, model and year from the billing screen."],
      ["verified_user", "Battery and tyre warranties", "Record serial numbers and handle warranty claims with suppliers."],
      ["build_circle", "Garage job cards", "Vehicle number, odometer reading, complaints, parts and labour, from estimate to invoice."],
      ["notifications", "Service reminders", "Remind customers when a service is due, by date or by kilometres."],
      ["inventory_2", "Rack and bin locations", "Know where each part is kept, with reorder levels for fast movers."],
    ],
    benefits: [
      ["Right part, first time", "Vehicle fit search will cut down wrong parts and returns."],
      ["Repeat garage visits", "Service reminders bring customers back on time."],
      ["Warranty claims on record", "Every battery and tyre sold can be traced by its serial number."],
    ],
    printers: "Thermal, A5 or A4",
    relatedIds: ["general-store-gst", "barcode-mrp-labels"],
  },
  {
    id: "supermarket-pos",
    code: "SPM",
    name: "Supermarket POS Software",
    shortName: "Supermarket POS",
    categoryId: "retail",
    icon: "shopping_cart",
    tagline: "Multi-counter billing with one shared stock for supermarkets and big kiranas.",
    summary:
      "Point-of-sale software for supermarkets, mini-marts and large kirana stores with two or more counters. It will share one stock across counters and handle weighing-scale barcodes, offers and loyalty points.",
    features: [
      ["devices", "Several counters, one stock", "Counters on your local network will bill from one central stock, with shift-wise cash-up."],
      ["scale", "Weighing-scale barcodes", "Read price or weight from barcodes printed by label scales, and bill loose items."],
      ["inventory_2", "Purchases with batch and expiry", "Batch, MRP and expiry on purchases, with supplier schemes and reorder suggestions."],
      ["percent", "Offers and loyalty", "Buy-X-get-Y offers, combos, MRP-based discounts and loyalty points."],
      ["label", "Shelf and price labels", "Print shelf-edge and price labels from the item list."],
      ["qr_code_2", "UPI QR at the counter", "Show a UPI QR code for the exact bill amount."],
    ],
    benefits: [
      ["Shorter queues", "Every counter bills from the same stock without waiting on the others."],
      ["Fewer pricing errors", "Offers will be applied by the software at every counter."],
      ["Clean shift handovers", "Cash-up for each counter and each shift."],
    ],
    extra: [["Network", "Billing counters connected over a local network"]],
    printers: "3-inch thermal at each counter; a label printer is optional",
    relatedIds: ["general-store-gst", "barcode-mrp-labels"],
  },
  {
    id: "garment-billing",
    code: "GRM",
    name: "Garment & Footwear Billing Software",
    shortName: "Garment & Footwear Billing",
    categoryId: "retail",
    icon: "checkroom",
    tagline: "Size and colour stock, barcode labels and exchanges for garment stores.",
    summary:
      "Billing software for garment, saree, boutique, footwear and kids-wear stores. It will track stock by style, size and colour, print barcode labels and handle exchanges with credit notes.",
    features: [
      ["inventory", "Style, size and colour", "Stock for every size and colour of a style, and what is left at a glance."],
      ["barcode_scanner", "Barcode labels", "Print labels on thermal label printers and bill by scanning them."],
      ["percent", "GST by selling price", "Where the GST rate depends on the selling price, the right rate will be picked for each piece."],
      ["swap_horiz", "Exchanges and returns", "Exchanges and returns with credit notes and exchange vouchers."],
      ["history", "Slow-moving stock", "See what has not sold in 30, 60 or 90 days, by season or collection."],
      ["group", "Salesmen and alterations", "Sales and incentives for each salesman, and alteration jobs to deliver."],
    ],
    benefits: [
      ["The right sizes in stock", "Size-wise stock will show what to reorder before the season peaks."],
      ["Quick billing in rush hours", "Scan a label and the item, size and price are on the bill."],
      ["Less dead stock", "Spot slow movers early and plan your sales."],
    ],
    printers: "Thermal or A4 for bills; a barcode label printer for tags",
    relatedIds: ["barcode-mrp-labels", "general-store-gst"],
  },
  {
    id: "mobile-shop-billing",
    code: "MOB",
    name: "Mobile & Electronics Shop Software",
    shortName: "Mobile & Electronics Shop",
    categoryId: "retail",
    icon: "smartphone",
    tagline: "IMEI-wise billing, warranties and repair job sheets for mobile shops.",
    summary:
      "Billing software for mobile, accessory, electronics and appliance shops and repair centres. It will track every unit by IMEI or serial number and handle warranties, repairs and used-phone purchases.",
    features: [
      ["barcode_scanner", "IMEI and serial for every unit", "IMEI or serial numbers captured at purchase and sale, with duplicates blocked and a full history for each IMEI."],
      ["devices", "Variants and accessories", "Stock by colour, RAM and storage, and barcode billing for accessories."],
      ["verified_user", "Warranty tracking", "Warranty end dates from the invoice date, warranty cards and returns to suppliers."],
      ["build_circle", "Repair job sheets", "Device, fault, IMEI, estimate and status for each repair, ending in a service invoice."],
      ["swap_horiz", "Used-phone purchases", "A register of used phones bought, with the seller’s ID details and the resale margin."],
      ["credit_card", "Finance and EMI sales", "Tag sales made through finance companies, and track brand scheme claims."],
    ],
    benefits: [
      ["Every phone traceable", "Find any handset sold or bought by its IMEI."],
      ["Repairs that don’t get lost", "Each job sheet will show its status until the device is handed back."],
      ["Fewer warranty disputes", "Warranty dates come straight from the bill."],
    ],
    printers: "Thermal or A4",
    relatedIds: ["general-store-gst", "barcode-mrp-labels"],
  },
  {
    id: "payroll",
    code: "PAY",
    name: "Payroll & Attendance Software",
    shortName: "Payroll & Attendance",
    categoryId: "finance",
    icon: "badge",
    tagline: "Salaries, attendance and PF, ESI and PT files for small employers.",
    summary:
      "Payroll software for employers and payroll accountants. It will work out salaries under the Labour Codes, prepare PF, ESI and professional tax files, and print payslips and registers.",
    features: [
      ["percent", "Labour Code wages", "Salaries will be worked out with the wage checks used for PF, ESI, gratuity and bonus."],
      ["description", "PF, ESI and PT files", "Prepare the PF ECR file, the ESI contribution file and state professional tax and LWF figures."],
      ["schedule", "Attendance import", "Import attendance from biometric device files or an Excel muster, with shifts, overtime and leave."],
      ["receipt_long", "Payslips and bank files", "Print payslips or share them as PDF, and create a bulk bank transfer file."],
      ["payments", "Loans, advances and settlements", "Loans and advances, arrears, and full and final settlement with gratuity."],
      ["summarize", "Statutory registers", "Wage, attendance and leave registers ready to print."],
      ["apartment", "Several companies", "Accountants will be able to run payroll for more than one company."],
    ],
    benefits: [
      ["Salaries on time", "Attendance flows straight into the salary sheet each month."],
      ["Returns without retyping", "PF and ESI files will come from the same payroll data."],
      ["Registers when asked for", "Wage, attendance and leave registers kept up to date every month."],
    ],
    printers: "Any A4 printer",
    relatedIds: ["cheque-printing"],
  },
  {
    id: "manufacturing-job-work",
    code: "MFG",
    name: "Manufacturing & Job Work Software",
    shortName: "Manufacturing & Job Work",
    categoryId: "industry",
    icon: "precision_manufacturing",
    tagline: "Bills of materials, production and job-work challans for small manufacturers.",
    summary:
      "Software for small manufacturers and processors. It will record production against bills of materials, track material sent to job workers and keep the ITC-04 register.",
    features: [
      ["inventory_2", "Bills of materials", "Multi-level bills of materials; a production entry will use up raw materials automatically, with by-products and scrap."],
      ["local_shipping", "Job-work challans", "Send material out and receive it back, with the balance held by each job worker and alerts for pending returns."],
      ["description", "ITC-04 register", "Keep the job-work register and export it for ITC-04."],
      ["manage_search", "Batches and costing", "Track batches or lots and cost them with material, labour and overheads."],
      ["receipt_long", "GST invoices and e-way bills", "Sales and purchase invoices, with e-way bill data for dispatches and job-work movement."],
      ["trending_down", "Reorder levels", "Reorder levels for raw materials, and stock reports for work in progress and finished goods."],
    ],
    benefits: [
      ["Know what each batch cost", "Material, labour and overheads in one place."],
      ["Material with job workers accounted for", "See what is out with each job worker and what is overdue."],
      ["Less work at return time", "The ITC-04 register will be built from everyday entries."],
    ],
    printers: "A4 or A5",
    relatedIds: ["barcode-mrp-labels", "transport-lr-billing"],
  },
  {
    id: "agri-input-billing",
    code: "AGR",
    name: "Agri-Input Shop Billing Software",
    shortName: "Agri-Input Shop Billing",
    categoryId: "retail",
    icon: "agriculture",
    tagline: "Licence details, batch and expiry, and farmer credit for agri-input shops.",
    summary:
      "Billing software for fertiliser, seed and pesticide shops. It will print licence numbers on bills, track batches and expiry dates, keep the stock registers and manage season-wise farmer credit.",
    features: [
      ["badge", "Licence numbers on bills", "Fertiliser, seed and insecticide licence numbers and your GSTIN on every invoice."],
      ["inventory_2", "Batch and expiry", "Batch or lot, manufacturing and expiry dates for pesticides and seeds, with expiry alerts."],
      ["summarize", "Stock registers", "Seed and insecticide stock registers and monthly returns, with formats checked state by state."],
      ["account_balance_wallet", "Farmer credit by season", "Udhaar until harvest, with interest and village-wise outstanding."],
      ["notifications", "Payment reminders", "Send due reminders to farmers by SMS or WhatsApp."],
      ["translate", "Bills in Hindi and Marathi", "Print bills in Hindi or Marathi as well as English."],
    ],
    benefits: [
      ["Records for every sale", "Licence details and registers will be kept for every sale."],
      ["Credit you can follow up", "Village-wise outstanding shows whom to call after harvest."],
      ["Less expired stock", "Expiry alerts give time to return or sell old batches."],
    ],
    internet: "Needed to activate, get updates and send SMS or WhatsApp reminders; billing works offline",
    printers: "Thermal, A5 or A4",
    relatedIds: ["mandi-commission-agent", "general-store-gst"],
  },
  {
    id: "bakery-sweet-shop",
    code: "BKY",
    name: "Bakery & Sweet Shop Software",
    shortName: "Bakery & Sweet Shop",
    categoryId: "restaurant",
    icon: "bakery_dining",
    tagline: "Billing by weight, cake orders and recipes for bakeries and sweet shops.",
    summary:
      "Billing software for bakeries, sweet and namkeen shops and cake shops. It will bill by weight from a connected scale, take cake orders with advances and record production against recipes.",
    features: [
      ["scale", "Billing by weight", "Read the weight from a connected scale, or from barcodes printed by a label scale."],
      ["space_dashboard", "Quick item buttons", "Touch-screen buttons for fast-selling items, with weight and piece items on one bill."],
      ["event", "Cake and custom orders", "Book orders with an advance, the delivery date and the message for the cake."],
      ["menu_book", "Recipes and production", "Record production against recipes, so raw materials are used up from stock."],
      ["event_busy", "Short shelf life", "Track expiry for items that last only days, and record wastage."],
      ["shopping_bag", "Festival boxes and hampers", "Make up gift boxes and hampers from loose items."],
    ],
    benefits: [
      ["A faster counter in the festive rush", "Weight and price will come straight from the scale."],
      ["No missed cake orders", "Every order with its date, advance and message in one list."],
      ["Know your real costs", "Recipe-based production shows where your raw material went."],
    ],
    extra: [["Weighing scale", "A scale with a serial or USB connection, or a barcode label scale"]],
    printers: "3-inch thermal for bills",
    relatedIds: ["restaurant-billing", "barcode-mrp-labels"],
  },
  {
    id: "textile-wholesale",
    code: "TXT",
    name: "Textile Wholesale Software",
    shortName: "Textile Wholesale",
    categoryId: "wholesale",
    icon: "texture",
    tagline: "Than and metre stock, agent commission and credit days for cloth traders.",
    summary:
      "Software for cloth, saree and fabric wholesalers and traders. It will keep stock in metres, thans and bales, work out agent commission, track credit days and record job work with processors.",
    features: [
      ["inventory", "Quality, design and shade", "Stock by quality, design number and shade, in metres, thans, pieces and bales."],
      ["handshake", "Agents and brokers", "Sales through agents, with commission worked out and agent-wise outstanding."],
      ["event", "Credit days and interest", "A due date for every bill, interest on late payment and reminders."],
      ["local_shipping", "Packing and transport", "Packing slips and bale numbers, with transport and LR details on invoices."],
      ["swap_horiz", "Job work with processors", "Issue cloth for dyeing, printing or embroidery and receive it back."],
      ["receipt_long", "GST invoices", "Item-wise GST rates, with e-invoice and e-way bill data for larger traders."],
    ],
    benefits: [
      ["Payments on time", "Bill-wise due dates show whom to follow up today."],
      ["Agent commission without disputes", "Commission will be worked out from the same bills the agent sold."],
      ["Cloth with processors accounted for", "See what is out for dyeing or printing and what has come back."],
    ],
    printers: "Dot-matrix, A4 or A5",
    relatedIds: ["garment-billing", "transport-lr-billing"],
  },
  {
    id: "petrol-pump",
    code: "PTL",
    name: "Petrol Pump Management Software",
    shortName: "Petrol Pump Management",
    categoryId: "industry",
    icon: "local_gas_station",
    tagline: "Meter readings, dip stock, shift settlement and credit bills for fuel stations.",
    summary:
      "Software for retail fuel outlets. It will record nozzle meter and tank dip readings, settle each shift’s cash, card and UPI, bill credit customers and keep lubricant stock.",
    features: [
      ["monitoring", "Nozzle meter readings", "Opening and closing readings for every nozzle each shift, with the testing quantity."],
      ["inventory", "Tank dip and stock", "Dip readings converted with your dip charts, stock variation and tanker decantation."],
      ["payments", "Shift settlement", "Settle cash, card, UPI and fleet cards for each shift and attendant, and print the daily sales report."],
      ["receipt_long", "Credit customers", "Vehicle-wise credit slips and periodic bills for credit customers."],
      ["inventory_2", "Lubricants", "Lubricant stock and sales, billed with GST."],
      ["schedule", "Rate changes", "Fuel rate changes by date and time, applied from the right moment."],
    ],
    benefits: [
      ["Shortages spotted the same day", "Meter, dip and cash figures will be matched every shift."],
      ["Credit bills without paperwork", "Slips add up into periodic bills for each customer."],
      ["A daily report you can rely on", "The daily sales report comes from the readings entered."],
    ],
    printers: "Thermal or A4",
    relatedIds: ["transport-lr-billing", "payroll"],
  },
  {
    id: "transport-lr-billing",
    code: "TRN",
    name: "Transport & LR Billing Software",
    shortName: "Transport & LR Billing",
    categoryId: "industry",
    icon: "local_shipping",
    tagline: "LR and bilty printing, trip sheets and freight bills for transporters.",
    summary:
      "Software for transport companies, booking agents and fleet owners. It will print LRs, keep booking and loading registers, track trip expenses and raise freight bills.",
    features: [
      ["description", "LR and bilty printing", "Consignment notes with consignor and consignee GSTIN, marked paid, to pay or to be billed."],
      ["task_alt", "Booking and loading registers", "A booking register, loading challans for each truck, and delivery and POD tracking."],
      ["route", "Trip sheets", "Diesel, toll, driver advances and expenses for each trip, with the trip’s profit."],
      ["receipt_long", "Freight bills", "Freight bills with the GST options that goods transport agencies use."],
      ["account_balance_wallet", "Party ledgers", "Outstanding for each party, and hire and broker payments for market vehicles."],
      ["event_busy", "Vehicle document alerts", "Reminders before insurance, permit, fitness and PUC certificates expire."],
    ],
    benefits: [
      ["Every consignment traceable", "From booking to proof of delivery, in one place."],
      ["Know which trips pay", "Trip expenses set against freight will show the profit on each trip."],
      ["No lapsed documents", "Expiry alerts give time to renew."],
    ],
    printers: "Dot-matrix or A4 for LRs and bills",
    relatedIds: ["petrol-pump", "fmcg-distribution"],
  },
  {
    id: "clinic-opd",
    code: "CLN",
    name: "Clinic (OPD) Software",
    shortName: "Clinic OPD",
    categoryId: "pharmacy",
    icon: "stethoscope",
    tagline: "Appointments, prescriptions, patient history and billing for clinics.",
    summary:
      "Software for doctors, dentists, physiotherapists and small polyclinics. It will manage appointments and tokens, print prescriptions on your letterhead, keep patient history and handle OPD billing.",
    features: [
      ["event", "Appointments and tokens", "Book appointments and run the token queue, with an optional display for the waiting area."],
      ["clinical_notes", "Quick prescriptions", "A medicine list with dosage templates and favourites, printed on your letterhead."],
      ["history", "Patient history", "Past visits, vitals, investigations and attached reports for each patient."],
      ["receipt_long", "OPD billing", "Consultation and procedure charges, packages, receipts and the day-end collection."],
      ["medication", "Clinic dispensary", "Optional stock and billing for medicines given out at the clinic."],
      ["notifications", "Follow-up reminders", "Remind patients of follow-up visits by SMS or WhatsApp."],
      ["shield", "Patient data controls", "Consent, export and deletion of a patient’s records when they ask."],
    ],
    benefits: [
      ["Shorter waits", "Patients will be seen in token order, with fewer questions at the desk."],
      ["Prescriptions in seconds", "Templates and favourites for the medicines you prescribe most."],
      ["Full history at every visit", "Previous visits and reports on one screen."],
    ],
    internet: "Needed to activate, get updates and send SMS or WhatsApp reminders; daily work runs offline",
    printers: "A4 or A5 for prescriptions and receipts",
    relatedIds: ["pathology-lab", "medical-billing"],
  },
  {
    id: "mandi-commission-agent",
    code: "MND",
    name: "Mandi Commission Agent Software",
    shortName: "Mandi Commission Agent",
    categoryId: "wholesale",
    icon: "gavel",
    tagline: "Auction entry, farmer pattis and market fee records for commission agents.",
    summary:
      "Software for APMC commission agents (adhatiyas) and fruit, vegetable and grain traders. It will record auctions lot by lot, make farmer pattis with every deduction and keep the market-fee records.",
    features: [
      ["gavel", "Auction entry", "Enter each lot’s boli, and purchases will flow into sales automatically."],
      ["receipt_long", "Farmer pattis", "Settlements with commission, hamali, tulai, market fee, bardana and transport deducted."],
      ["swap_horiz", "Own and commission trading", "Keep self-trading and commission trading apart, and track crates and bardana."],
      ["summarize", "Market-fee records", "The market-fee register, stock statement and sales reports for the APMC."],
      ["translate", "Regional language printing", "Print pattis and bills in Hindi, Marathi or Punjabi as well as English."],
      ["wifi_off", "Works without internet", "Daily work in the mandi yard will not need an internet connection."],
    ],
    benefits: [
      ["Pattis ready the same day", "Deductions will be worked out for every farmer automatically."],
      ["Fewer disputes", "Each lot’s rate and weight on record."],
      ["An up-to-date cash book", "Party ledgers with interest and a daily cash book."],
    ],
    printers: "Dot-matrix, A5 or A4",
    relatedIds: ["agri-input-billing", "transport-lr-billing"],
  },
  {
    id: "barcode-mrp-labels",
    code: "LBL",
    name: "Barcode & MRP Label Software",
    shortName: "Barcode & MRP Labels",
    categoryId: "finance",
    icon: "label",
    tagline: "Print MRP, barcode and shelf labels in bulk from Excel or your item list.",
    summary:
      "Label printing software for packers, small manufacturers, retailers and distributors. It will print MRP labels, barcodes and price tags in bulk from Excel, CSV or a purchase bill.",
    features: [
      ["sell", "MRP label templates", "Templates for MRP, net quantity, month and year of manufacture, best before, FSSAI number and customer care details."],
      ["upload", "Print from Excel or CSV", "Print runs driven by an Excel or CSV file, your item list or the quantities on a purchase bill."],
      ["barcode_scanner", "Barcodes and QR codes", "EAN-13, Code 128, QR and GS1 barcodes, with serial and batch numbers that count up."],
      ["print", "Label printers and sheets", "Thermal label printers and A4 sticker sheets will both be supported."],
      ["translate", "Hindi and regional text", "Labels in Hindi and other Indian languages."],
      ["autorenew", "Relabel after price changes", "Reprint labels for the items whose price changed."],
    ],
    benefits: [
      ["The same details every time", "MRP and pack details will be printed the same way on every label."],
      ["Bulk runs from one file", "Print a whole batch of labels from one list."],
      ["No retyping", "Use the item list you already have."],
    ],
    printers: "Thermal label printers or A4 sticker sheets",
    relatedIds: ["general-store-gst", "garment-billing", "supermarket-pos"],
  },
  {
    id: "pathology-lab",
    code: "LAB",
    name: "Pathology Lab Software",
    shortName: "Pathology Lab",
    categoryId: "pharmacy",
    icon: "biotech",
    tagline: "Test reports, sample barcodes, billing and referrals for pathology labs.",
    summary:
      "Software for pathology labs, collection centres and small diagnostic centres. It will register patients, label samples, print reports on your letterhead and handle billing and referral commission.",
    features: [
      ["menu_book", "Tests, panels and profiles", "Tests, panels and profiles with age- and sex-wise reference ranges, and calculated tests."],
      ["barcode_scanner", "Sample barcodes", "Register patients, print sample barcode labels and work from worklists."],
      ["description", "Reports on your letterhead", "Reports with the pathologist’s signature and abnormal values flagged, shared as PDF or on WhatsApp."],
      ["handshake", "Referral commission", "Commission for referring doctors and collection centres, and B2B billing."],
      ["receipt_long", "Billing and dues", "Discounts, dues and a day-end cash and UPI report."],
      ["monitoring", "Report history", "Past reports and trends for each patient."],
      ["shield", "Patient data controls", "Consent, export and deletion of a patient’s records when they ask."],
    ],
    benefits: [
      ["Reports out faster", "Results will go from the worklist to the printed report without retyping."],
      ["Fewer sample mix-ups", "Barcode labels tie each sample to its patient."],
      ["Clear referral accounts", "Commission worked out for every referral."],
    ],
    internet: "Needed to activate, get updates and share reports on WhatsApp; daily work runs offline",
    printers: "A4 for reports; a barcode label printer for samples",
    relatedIds: ["clinic-opd", "medical-billing"],
  },
  {
    id: "housing-society-billing",
    code: "SOC",
    name: "Housing Society Billing Software",
    shortName: "Housing Society Billing",
    categoryId: "finance",
    icon: "apartment",
    tagline: "Maintenance bills, receipts and accounts for housing societies.",
    summary:
      "Billing and accounting software for co-operative housing societies and the accountants who keep their books. It will raise maintenance bills, charge interest on arrears and prepare the society’s accounts.",
    features: [
      ["receipt_long", "Maintenance bills", "Bills per square foot, per flat or as fixed heads, with sinking and repair funds."],
      ["percent", "Interest on arrears", "Interest on overdue amounts, receipts, member ledgers and defaulter lists."],
      ["summarize", "Society accounts", "Income and expenditure, receipts and payments, and the balance sheet for the audit."],
      ["group", "Member registers", "Member and share registers, and nominations."],
      ["swap_horiz", "Many societies, one login", "Accountants will be able to switch between the societies they look after."],
      ["qr_code_2", "Bills with a UPI QR", "Send bills by WhatsApp, SMS or email with a UPI QR code for payment."],
      ["account_balance", "Bank reconciliation", "Match bank statements with receipts and payments."],
    ],
    benefits: [
      ["Bills out on time", "Monthly bills for every flat in one run."],
      ["Fewer defaulters", "Interest and reminders will be applied the same way to every member."],
      ["An easier year end", "Accounts build up through the year from bills and receipts."],
    ],
    internet: "Needed to activate, get updates and send bills by WhatsApp, SMS or email; billing works offline",
    printers: "Any A4 printer",
    relatedIds: ["cheque-printing", "payroll"],
  },
]);

/** Ids of the coming-soon products, in rank order. */
export const COMING_SOON_PRODUCT_IDS: readonly string[] = COMING_SOON_PRODUCTS.map((p) => p.id);

export function findComingSoonProduct(productId: string): SeedComingSoonProduct | null {
  return COMING_SOON_PRODUCTS.find((p) => p.id === productId) ?? null;
}

/**
 * The Product row of a coming-soon product (dev seed and the production catalog addition write the same row):
 * status COMING_SOON, the category's colour (no tone override), demo requests off, content validated.
 */
export function comingSoonProductRow(p: SeedComingSoonProduct): WithId<Prisma.ProductCreateManyInput> {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    summary: p.summary,
    icon: p.icon,
    tone: null,
    categoryId: p.categoryId,
    platforms: [...p.platforms],
    status: PublishStatus.COMING_SOON,
    demoEnabled: false,
    rank: p.rank,
    content: productContentSchema.parse(p.content),
    relatedIds: [...p.relatedIds],
    createdAt: startOfDayIST(p.added),
  };
}
