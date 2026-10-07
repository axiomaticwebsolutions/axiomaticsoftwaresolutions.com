import { describe, expect, it } from "vitest";
import {
  attachmentsBlocker,
  checkAttachment,
  contentTypeForFile,
  newAttachmentItem,
  planAttachments,
  planMessages,
  readyUploadIds,
  uploadErrorMessage,
  uploadPercent,
  type AttachmentItem,
} from "@/components/account/tickets/attachments-model";

const MB = 1024 * 1024;
const file = (name: string, size: number, type: string) => ({ name, size, type });

describe("ticket attachment checks", () => {
  it("accepts PNG, JPEG, PDF and TXT whose extension matches", () => {
    expect(contentTypeForFile(file("scanner-error.png", 10, "image/png"))).toBe("image/png");
    expect(contentTypeForFile(file("photo.JPG", 10, "image/jpeg"))).toBe("image/jpeg");
    expect(contentTypeForFile(file("guide.pdf", 10, "application/pdf"))).toBe("application/pdf");
    expect(contentTypeForFile(file("notes.txt", 10, "text/plain"))).toBe("text/plain");
  });

  it("infers the type from the extension when the browser reports none", () => {
    expect(contentTypeForFile(file("billing.log", 10, ""))).toBe("text/plain");
    expect(contentTypeForFile(file("invoice.pdf", 10, "application/octet-stream"))).toBe("application/pdf");
    expect(contentTypeForFile(file("setup.exe", 10, ""))).toBeNull();
  });

  it("refuses a harmless type on a dangerous name, and other types", () => {
    expect(contentTypeForFile(file("setup.exe", 10, "image/png"))).toBeNull();
    expect(contentTypeForFile(file("photo.heic", 10, "image/heic"))).toBeNull();
    expect(contentTypeForFile(file("noext", 10, "text/plain"))).toBeNull();
  });

  it("checks size and name with the upload API's messages", () => {
    expect(checkAttachment(file("a.png", 0, "image/png"))).toEqual({ ok: false, error: "This file is empty." });
    expect(checkAttachment(file("a.png", 10 * MB + 1, "image/png"))).toEqual({ ok: false, error: "Each file can be up to 10 MB." });
    expect(checkAttachment(file("a.png", 10 * MB, "image/png"))).toEqual({ ok: true, contentType: "image/png" });
    expect(checkAttachment(file("a.gif", 5, "image/gif"))).toEqual({ ok: false, error: "Attach PNG, JPEG, PDF or TXT files." });
    expect(checkAttachment(file(`${"x".repeat(151)}.png`, 5, "image/png"))).toEqual({
      ok: false,
      error: "Use a file name of 150 characters or fewer.",
    });
    expect(checkAttachment(file("   ", 5, "image/png"))).toEqual({ ok: false, error: "This file needs a name." });
  });

  it("keeps the first files up to five and explains the rest", () => {
    const plan = planAttachments(3, [
      file("one.png", 5, "image/png"),
      file("bad.gif", 5, "image/gif"),
      file("two.pdf", 5, "application/pdf"),
      file("three.txt", 5, "text/plain"),
    ]);
    expect(plan.accepted.map((a) => a.file.name)).toEqual(["one.png", "two.pdf"]);
    expect(plan.rejected).toEqual([{ name: "bad.gif", error: "Attach PNG, JPEG, PDF or TXT files." }]);
    expect(plan.overLimit).toBe(true);
    expect(planMessages(plan)).toEqual(["bad.gif: Attach PNG, JPEG, PDF or TXT files.", "Attach up to 5 files."]);
    expect(planAttachments(5, [file("x.png", 5, "image/png")]).accepted).toEqual([]);
  });
});

describe("ticket attachment state", () => {
  const item = (over: Partial<AttachmentItem>): AttachmentItem => ({
    ...newAttachmentItem("k", file("a.png", 219136, "image/png"), "image/png"),
    ...over,
  });

  it("labels sizes like the server and starts uploading", () => {
    expect(item({}).sizeLabel).toBe("214 KB");
    expect(item({}).status).toBe("uploading");
  });

  it("computes upload progress", () => {
    expect(uploadPercent(50, 200)).toBe(25);
    expect(uploadPercent(5, 0)).toBe(0);
    expect(uploadPercent(300, 200)).toBe(100);
  });

  it("sends only ready uploads and blocks while files upload or failed", () => {
    const ready = item({ key: "a", status: "ready", uploadId: "u1" });
    const failed = item({ key: "b", status: "error", error: "x" });
    const busy = item({ key: "c", status: "uploading" });
    expect(readyUploadIds([ready, failed])).toEqual(["u1"]);
    expect(attachmentsBlocker([ready])).toBeNull();
    expect(attachmentsBlocker([ready, busy])).toBe("Wait for your files to finish uploading.");
    expect(attachmentsBlocker([ready, failed])).toBe("Remove the files that didn\u2019t upload, or try them again.");
  });

  it("prefers the field error of a failed upload request", () => {
    expect(
      uploadErrorMessage({ message: "Check the highlighted fields.", fieldErrors: { contentType: ["Attach PNG, JPEG, PDF or TXT files."] } }),
    ).toBe("Attach PNG, JPEG, PDF or TXT files.");
    expect(uploadErrorMessage({ message: "Too many attempts.", fieldErrors: {} })).toBe("Too many attempts.");
    expect(uploadErrorMessage({ message: "x", fieldErrors: { other: ["Other problem."] } })).toBe("Other problem.");
  });
});
