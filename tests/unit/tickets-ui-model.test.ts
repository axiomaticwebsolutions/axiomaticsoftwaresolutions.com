import { describe, expect, it } from "vitest";
import { TICKET_STATUS_TABS, TICKETS_LIST, ticketQueryFromListState } from "@/components/account/tickets/list-config";
import {
  followUpTicketHref,
  IMPACT_OPTIONS,
  initialTicketTarget,
  licenseOptionsFor,
  NEW_TICKET_FIELD_IDS,
  newTicketErrorsFromApi,
  newTicketSummary,
  openCountDelta,
  readOnlyNotice,
  replyError,
  supportHoursNote,
  ticketComposer,
  ticketCreatedToast,
  ticketMetaRows,
  ticketStatusTone,
  validateNewTicket,
  type NewTicketLicense,
  type NewTicketProduct,
} from "@/components/account/tickets/model";
import { listStateHref, parseListState } from "@/lib/url-state";

describe("tickets list URL state", () => {
  it("defaults to all statuses and products, most recently updated first", () => {
    const state = parseListState(new URLSearchParams(""), TICKETS_LIST);
    expect(ticketQueryFromListState(state)).toEqual({
      status: "all",
      product: "all",
      q: "",
      sort: { key: "updated", dir: -1 },
      page: 1,
    });
  });

  it("reads search, status, product, sort and page", () => {
    const params = new URLSearchParams("q=scanner&status=awaiting_customer&product=medical-billing&sort=-priority&page=2");
    expect(ticketQueryFromListState(parseListState(params, TICKETS_LIST))).toEqual({
      status: "awaiting_customer",
      product: "medical-billing",
      q: "scanner",
      sort: { key: "priority", dir: -1 },
      page: 2,
    });
  });

  it("falls back to the defaults for values the list does not offer", () => {
    const params = new URLSearchParams("status=closed&sort=-subject&product=../x&page=-3");
    const query = ticketQueryFromListState(parseListState(params, TICKETS_LIST));
    expect(query.status).toBe("all");
    expect(query.sort).toEqual({ key: "updated", dir: -1 });
    expect(query.product).toBe("all");
    expect(query.page).toBe(1);
  });

  it("keeps defaults out of the URL", () => {
    const state = parseListState(new URLSearchParams("status=resolved"), TICKETS_LIST);
    expect(listStateHref("/account/tickets", state, TICKETS_LIST)).toBe("/account/tickets?status=resolved");
    const reset = parseListState(new URLSearchParams("sort=-updated&page=1"), TICKETS_LIST);
    expect(listStateHref("/account/tickets", reset, TICKETS_LIST)).toBe("/account/tickets");
  });

  it("offers the prototype's status tabs in order", () => {
    expect(TICKET_STATUS_TABS.map((t) => t.label)).toEqual(["Open", "Needs your reply", "Resolved", "All"]);
  });
});

describe("ticket list and detail copy", () => {
  it("builds the support-hours footer, marking sample hours as configurable", () => {
    expect(supportHoursNote("Mon\u2013Sat, 10:00\u201319:00 IST", true)).toBe(
      "Standard support: first reply within 1 business day \u00B7 Mon\u2013Sat, 10:00\u201319:00 IST (configurable)",
    );
    expect(supportHoursNote(" Mon\u2013Fri ", false)).toBe("Standard support: first reply within 1 business day \u00B7 Mon\u2013Fri");
  });

  it("maps statuses to the prototype badge tones", () => {
    expect(ticketStatusTone("open")).toBe("blue");
    expect(ticketStatusTone("awaiting_customer")).toBe("peach");
    expect(ticketStatusTone("resolved")).toBe("sage");
    expect(ticketStatusTone("closed")).toBe("slate");
  });

  it("explains the read-only state with the roles that may reply", () => {
    expect(readOnlyNotice("VIEWER")).toBe(
      "Replying needs Owner, Billing admin or Technical contact access. You\u2019re signed in as Viewer.",
    );
    expect(ticketCreatedToast("T-3019")).toBe("Ticket T-3019 created");
  });

  it("lists the details panel in prototype order, with the license and opener added", () => {
    const ticket = {
      statusLabel: "Waiting for you",
      priorityLabel: "High",
      productShortName: "Medical Store Billing",
      productName: "Medical Store Billing Software",
      licenseId: "LIC-24017",
      assigneeLabel: "Sneha",
      raisedBy: "Priya Sharma",
      createdAt: "2026-10-05T22:44:10.572Z",
      updatedAt: "2026-10-06T17:56:10.572Z",
      replyTarget: "1 business day",
    };
    const rows = ticketMetaRows(ticket, () => "10h ago");
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Status", "Waiting for you"],
      ["Priority", "High"],
      ["Product", "Medical Store Billing"],
      ["License", "LIC-24017"],
      ["Assigned to", "Sneha"],
      ["Opened by", "Priya Sharma"],
      ["Opened", "6 Oct 2026"],
      ["Last update", "10h ago"],
      ["Reply target", "1 business day"],
    ]);
    expect(rows.find((r) => r.key === "license")?.href).toBe("/account/licenses/LIC-24017");
    const plain = ticketMetaRows({ ...ticket, licenseId: null, productShortName: null, productName: null }, () => "now");
    expect(plain.map((r) => r.label)).not.toContain("License");
    expect(plain.find((r) => r.key === "product")?.value).toBe("\u2014");
  });

  it("chooses the composer from the status and the role", () => {
    expect(ticketComposer("open", true)).toBe("reply");
    expect(ticketComposer("awaiting_customer", false)).toBe("readonly");
    expect(ticketComposer("resolved", true)).toBe("resolved");
    expect(ticketComposer("resolved", false)).toBe("resolved");
    expect(ticketComposer("closed", true)).toBe("closed");
  });

  it("starts a follow-up ticket on the same product and license", () => {
    expect(followUpTicketHref({ productId: "medical-billing", licenseId: "LIC-24017" })).toBe(
      "/account/tickets/new?product=medical-billing&license=LIC-24017",
    );
    expect(followUpTicketHref({ productId: null, licenseId: null })).toBe("/account/tickets/new");
  });

  it("tracks the open-tickets badge across status changes", () => {
    expect(openCountDelta("awaiting_customer", "resolved")).toBe(-1);
    expect(openCountDelta("resolved", "open")).toBe(1);
    expect(openCountDelta("awaiting_customer", "open")).toBe(0);
  });

  it("validates replies with the API's message", () => {
    expect(replyError("")).toBe("Write a message before sending.");
    expect(replyError("   \n ")).toBe("Write a message before sending.");
    expect(replyError("Thanks, that fixed it.")).toBeNull();
  });
});

describe("new ticket form", () => {
  const products: NewTicketProduct[] = [
    { id: "medical-billing", name: "Medical Store Billing Software" },
    { id: "restaurant-billing", name: "Restaurant Billing Software" },
    { id: "cheque-printing", name: "Cheque Printing Software" },
  ];
  const licenses: NewTicketLicense[] = [
    { id: "LIC-23961", productId: "cheque-printing", planName: "One-time license" },
    { id: "LIC-24017", productId: "medical-billing", planName: "Annual" },
    { id: "LIC-24102", productId: "medical-billing", planName: "Free trial" },
  ];

  it("has the prototype's impact cards with Normal as the default", () => {
    expect(IMPACT_OPTIONS).toEqual([
      { value: "low", label: "Low", hint: "Question or how-to" },
      { value: "normal", label: "Normal", hint: "Something isn\u2019t working as expected" },
      { value: "high", label: "High", hint: "Billing is blocked at the counter" },
    ]);
  });

  it("lists the related licenses of the chosen product", () => {
    expect(licenseOptionsFor(licenses, "medical-billing")).toEqual([
      { value: "LIC-24017", label: "LIC-24017 \u00B7 Annual" },
      { value: "LIC-24102", label: "LIC-24102 \u00B7 Free trial" },
    ]);
    expect(licenseOptionsFor(licenses, "restaurant-billing")).toEqual([]);
  });

  it("starts from ?license=, then ?product=, then the first licensed product", () => {
    expect(initialTicketTarget(products, licenses, { license: "LIC-23961" })).toEqual({ productId: "cheque-printing", licenseId: "LIC-23961" });
    expect(initialTicketTarget(products, licenses, { product: "restaurant-billing" })).toEqual({ productId: "restaurant-billing", licenseId: "" });
    expect(initialTicketTarget(products, licenses, { license: "LIC-99999", product: "nope" })).toEqual({ productId: "medical-billing", licenseId: "" });
    expect(initialTicketTarget(products, [], {})).toEqual({ productId: "medical-billing", licenseId: "" });
    expect(initialTicketTarget([], licenses, {})).toEqual({ productId: "", licenseId: "" });
  });

  it("reports the prototype's errors for a short subject and description", () => {
    const result = validateNewTicket({ productId: "medical-billing", licenseId: "", subject: "Help", impact: "normal", body: "Broken" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      subject: "Add a short subject (at least 6 characters).",
      body: "Please describe the problem in a bit more detail (20+ characters).",
    });
    expect(newTicketSummary(result.errors)).toEqual([
      { fieldId: NEW_TICKET_FIELD_IDS.subject, message: "Add a short subject (at least 6 characters)." },
      { fieldId: NEW_TICKET_FIELD_IDS.body, message: "Please describe the problem in a bit more detail (20+ characters)." },
    ]);
  });

  it("produces the API body for a valid ticket", () => {
    const result = validateNewTicket(
      {
        productId: "medical-billing",
        licenseId: "",
        subject: "  Scanner   not working ",
        impact: "high",
        body: "The barcode scanner stopped working after the update.\r\n",
      },
      ["upl_1"],
    );
    expect(result).toEqual({
      ok: true,
      data: {
        productId: "medical-billing",
        licenseId: null,
        subject: "Scanner not working",
        impact: "high",
        body: "The barcode scanner stopped working after the update.",
        attachmentIds: ["upl_1"],
      },
    });
  });

  it("maps server field errors onto the form", () => {
    expect(
      newTicketErrorsFromApi({
        productId: ["Choose a product."],
        "attachmentIds.0": ["One of the attachments isn\u2019t available any more. Remove it and attach it again."],
        extra: ["Unknown field."],
        body: [],
      }),
    ).toEqual({
      productId: "Choose a product.",
      attachmentIds: "One of the attachments isn\u2019t available any more. Remove it and attach it again.",
    });
  });
});
