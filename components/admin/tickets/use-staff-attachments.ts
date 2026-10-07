"use client";

/**
 * Staff ticket attachments in the browser (decisions.md Phase 6: staff attachments use Upload rows). Same flow and
 * rules as the portal (components/account/tickets/use-attachments.ts), against the ticket's admin endpoints:
 * (1) POST /api/admin/tickets/:id/uploads -> presigned PUT, (2) PUT the bytes to storage with exactly the returned
 * headers (XMLHttpRequest, for progress), (3) POST /api/admin/tickets/:id/uploads/:uploadId/confirm. Ready ids go
 * into `attachmentIds` of the reply or note. The pure checks and copy come from the shared attachments model, and the
 * controller has the portal's shape, so its presentational chips and messages can render it.
 */
import * as React from "react";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import {
  ATTACHMENT_COPY,
  attachmentsBlocker,
  failedAnnouncement,
  newAttachmentItem,
  planAttachments,
  planMessages,
  readyUploadIds,
  uploadedAnnouncement,
  uploadErrorMessage,
  uploadPercent,
  type AttachmentItem,
} from "@/components/account/tickets/attachments-model";
import type { AttachmentsController } from "@/components/account/tickets/use-attachments";
import type { AttachmentContentType } from "@/lib/validation/tickets";
import { ticketUploadsPath } from "./console-model";

type PresignResponse = {
  upload: { id: string };
  put: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
};

class PutError extends Error {}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function putFile(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(uploadPercent(event.loaded, event.total));
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PutError(`Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new PutError("Upload failed."));
    };
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(file);
  });
}

/** Attachments picked for one ticket's reply box. Switching tickets (a new `ticketId`) forgets every file. */
export function useStaffAttachments(ticketId: string | null): AttachmentsController {
  const [items, setItems] = React.useState<AttachmentItem[]>([]);
  const [messages, setMessages] = React.useState<string[]>([]);
  const [announcement, setAnnouncement] = React.useState("");
  const files = React.useRef(new Map<string, { file: File; contentType: AttachmentContentType; ticketId: string }>());
  const controllers = React.useRef(new Map<string, AbortController>());
  const counter = React.useRef(0);
  const itemsRef = React.useRef(items);
  React.useEffect(() => {
    itemsRef.current = items;
  });

  const patch = React.useCallback((key: string, change: Partial<AttachmentItem>) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const run = React.useCallback(
    async (key: string) => {
      const entry = files.current.get(key);
      if (!entry) return;
      const { file, contentType } = entry;
      controllers.current.get(key)?.abort();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      const { signal } = controller;
      try {
        const presign = await apiFetch<PresignResponse>(ticketUploadsPath(entry.ticketId), {
          method: "POST",
          body: { fileName: file.name, contentType, sizeBytes: file.size },
          signal,
        });
        patch(key, { uploadId: presign.upload.id });
        await putFile(presign.put.url, presign.put.headers, file, (progress) => patch(key, { progress }), signal);
        await apiFetch(ticketUploadsPath(entry.ticketId, presign.upload.id), { method: "POST", signal });
        patch(key, { status: "ready", progress: 100, error: null });
        setAnnouncement(uploadedAnnouncement(file.name));
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        const message =
          error instanceof ApiClientError ? uploadErrorMessage({ message: error.message, fieldErrors: error.fieldErrors }) : ATTACHMENT_COPY.uploadFailed;
        patch(key, { status: "error", error: message, uploadId: null });
        setAnnouncement(failedAnnouncement(file.name, message));
      } finally {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      }
    },
    [patch],
  );

  const add = React.useCallback(
    (list: FileList | readonly File[] | null) => {
      const picked = list ? Array.from(list) : [];
      if (picked.length === 0 || !ticketId) return;
      const plan = planAttachments(itemsRef.current.length, picked);
      setMessages(planMessages(plan));
      const added = plan.accepted.map(({ file, contentType }) => {
        counter.current += 1;
        const key = `staff-att-${counter.current}`;
        files.current.set(key, { file, contentType, ticketId });
        return newAttachmentItem(key, file, contentType);
      });
      if (added.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...added];
      setItems((prev) => [...prev, ...added]);
      for (const item of added) void run(item.key);
    },
    [run, ticketId],
  );

  const remove = React.useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    files.current.delete(key);
    itemsRef.current = itemsRef.current.filter((item) => item.key !== key);
    setItems((prev) => prev.filter((item) => item.key !== key));
    setMessages([]);
  }, []);

  const retry = React.useCallback(
    (key: string) => {
      patch(key, { status: "uploading", progress: 0, error: null, uploadId: null });
      void run(key);
    },
    [patch, run],
  );

  const reset = React.useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    files.current.clear();
    itemsRef.current = [];
    setItems([]);
    setMessages([]);
    setAnnouncement("");
  }, []);

  // Another ticket: its files belong to the previous ticket's account, so drop them.
  React.useEffect(() => reset, [ticketId, reset]);

  return {
    items,
    messages,
    announcement,
    add,
    remove,
    retry,
    reset,
    readyIds: readyUploadIds(items),
    blocker: attachmentsBlocker(items),
  };
}
