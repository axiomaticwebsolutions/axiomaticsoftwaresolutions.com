/**
 * Pure rules of the ticket and attachment modules: derived status (auto-close after 14 days), list tabs, author
 * labels, upload storage keys and the defensive reading of TicketMessage.attachments.
 */
import { describe, expect, it } from "vitest";
import { authorLabel, deriveTicketStatus, statusesForFilter } from "@/lib/portal/tickets";
import { attachmentViews, sanitizeUploadName, uploadStorageKey } from "@/lib/portal/uploads";
import { isStorageKey } from "@/lib/storage";
import { TICKET_AUTO_CLOSE_DAYS } from "@/lib/validation/tickets";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const DAY = 86_400_000;

describe("deriveTicketStatus", () => {
  it("maps stored statuses to the portal keys", () => {
    expect(deriveTicketStatus({ status: "OPEN", resolvedAt: null }, NOW)).toBe("open");
    expect(deriveTicketStatus({ status: "AWAITING_CUSTOMER", resolvedAt: null }, NOW)).toBe("awaiting_customer");
    expect(deriveTicketStatus({ status: "CLOSED", resolvedAt: null }, NOW)).toBe("closed");
  });

  it("treats a ticket resolved 14 days ago as closed (it can no longer be reopened)", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY);
    expect(deriveTicketStatus({ status: "RESOLVED", resolvedAt: at(TICKET_AUTO_CLOSE_DAYS - 0.01) }, NOW)).toBe("resolved");
    expect(deriveTicketStatus({ status: "RESOLVED", resolvedAt: at(TICKET_AUTO_CLOSE_DAYS) }, NOW)).toBe("closed");
    // Without a resolution time (older sample data) it stays resolved.
    expect(deriveTicketStatus({ status: "RESOLVED", resolvedAt: null }, NOW)).toBe("resolved");
  });

  it("groups the list tabs like the prototype (Open = not resolved; Resolved includes closed)", () => {
    expect(statusesForFilter("open")).toEqual(["OPEN", "AWAITING_CUSTOMER"]);
    expect(statusesForFilter("awaiting_customer")).toEqual(["AWAITING_CUSTOMER"]);
    expect(statusesForFilter("resolved")).toEqual(["RESOLVED", "CLOSED"]);
    expect(statusesForFilter("all")).toBeNull();
  });
});

describe("authorLabel", () => {
  it("shows staff as '<first name> · Axiomatic Support' and customers by name (email when blank)", () => {
    expect(authorLabel({ name: "Sneha Patil", email: "s@a.example", kind: "STAFF" }, true)).toBe("Sneha \u00B7 Axiomatic Support");
    expect(authorLabel({ name: "", email: "s@a.example", kind: "STAFF" }, true)).toBe("Axiomatic Support");
    expect(authorLabel({ name: "Priya Sharma", email: "p@s.example", kind: "CUSTOMER" }, false)).toBe("Priya Sharma");
    expect(authorLabel({ name: " ", email: "p@s.example", kind: "CUSTOMER" }, false)).toBe("p@s.example");
  });
});

describe("upload keys", () => {
  it("keeps a readable ASCII name and the extension", () => {
    expect(sanitizeUploadName("scanner-error.png")).toBe("scanner-error.png");
    expect(sanitizeUploadName("Café bill (copy) #2.PDF")).toBe("Cafe-bill-copy-2.pdf");
    expect(sanitizeUploadName("..\u002F..\u002Fetc\u002Fpasswd.txt")).toBe("etc-passwd.txt");
    expect(sanitizeUploadName("रसीद.jpg")).toBe("file.jpg");
    expect(sanitizeUploadName(`${"a".repeat(200)}.txt`)).toBe(`${"a".repeat(80)}.txt`);
  });

  it("builds uploads/<accountId>/<uuid>/<name> keys that the storage drivers accept", () => {
    const key = uploadStorageKey("seed_acct_sharma", "../../x y.png", "0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(key).toBe("uploads/seed_acct_sharma/0f8fad5b-d9cb-469f-a165-70867728950e/x-y.png");
    expect(isStorageKey(key)).toBe(true);
    const random = uploadStorageKey("cmabc123", "a.pdf");
    expect(random).toMatch(/^uploads\/cmabc123\/[0-9a-f-]{36}\/a\.pdf$/);
    expect(() => uploadStorageKey("../other", "a.pdf")).toThrow();
  });
});

describe("attachmentViews", () => {
  it("reads attachment JSON without exposing storage keys; sample files have no download id", () => {
    const views = attachmentViews([
      { uploadId: "up1", name: "scanner-error.png", sizeBytes: 219136, contentType: "image/png", storageKey: "uploads/a/b/c.png" },
      { name: "b2b-format-guide.pdf", sizeBytes: 389120, storageKey: "sample/tickets/T-2994/b2b-format-guide.pdf" },
      { name: 42 },
      null,
    ]);
    expect(views).toEqual([
      { id: "up1", name: "scanner-error.png", sizeBytes: 219136, sizeLabel: "214 KB", contentType: "image/png" },
      { id: null, name: "b2b-format-guide.pdf", sizeBytes: 389120, sizeLabel: "380 KB", contentType: null },
    ]);
    expect(JSON.stringify(views)).not.toContain("storageKey");
    expect(attachmentViews("nope")).toEqual([]);
  });
});
