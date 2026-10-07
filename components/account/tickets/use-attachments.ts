"use client";

/**
 * Ticket attachment uploads (decisions.md Phase 5; api-contracts section 5 POST /api/account/uploads). For each
 * picked file: (1) POST /api/account/uploads { fileName, contentType, sizeBytes } -> presigned PUT, (2) PUT the bytes
 * straight to storage with exactly the returned headers (XMLHttpRequest, for upload progress), (3) POST
 * /api/account/uploads/:id/confirm. Ready files' ids go into `attachmentIds` of the ticket or reply. Removing a file
 * aborts its upload; an unsent upload stays pending on the server until it expires.
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
import type { AttachmentContentType } from "@/lib/validation/tickets";

type PresignResponse = {
  upload: { id: string };
  put: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
};

class PutError extends Error {}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** PUT a file to a presigned URL with progress; rejects with AbortError when `signal` aborts. */
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

export type AttachmentsController = {
  items: AttachmentItem[];
  /** Messages about refused files of the last selection ("x.heic: Attach PNG, JPEG, PDF or TXT files."). */
  messages: string[];
  /** Polite announcement of the latest upload result (for a live region). */
  announcement: string;
  add: (files: FileList | readonly File[] | null) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** Forget every file (after the message was sent). */
  reset: () => void;
  readyIds: string[];
  /** Why the message cannot be sent yet, or null. */
  blocker: string | null;
};

export function useAttachments(): AttachmentsController {
  const [items, setItems] = React.useState<AttachmentItem[]>([]);
  const [messages, setMessages] = React.useState<string[]>([]);
  const [announcement, setAnnouncement] = React.useState("");
  const files = React.useRef(new Map<string, { file: File; contentType: AttachmentContentType }>());
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
        const presign = await apiFetch<PresignResponse>("/api/account/uploads", {
          method: "POST",
          body: { fileName: file.name, contentType, sizeBytes: file.size },
          signal,
        });
        patch(key, { uploadId: presign.upload.id });
        await putFile(presign.put.url, presign.put.headers, file, (progress) => patch(key, { progress }), signal);
        await apiFetch(`/api/account/uploads/${encodeURIComponent(presign.upload.id)}/confirm`, { method: "POST", signal });
        patch(key, { status: "ready", progress: 100, error: null });
        setAnnouncement(uploadedAnnouncement(file.name));
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        const message =
          error instanceof ApiClientError
            ? uploadErrorMessage({ message: error.message, fieldErrors: error.fieldErrors })
            : ATTACHMENT_COPY.uploadFailed;
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
      if (picked.length === 0) return;
      const plan = planAttachments(itemsRef.current.length, picked);
      setMessages(planMessages(plan));
      const added = plan.accepted.map(({ file, contentType }) => {
        counter.current += 1;
        const key = `att-${counter.current}`;
        files.current.set(key, { file, contentType });
        return newAttachmentItem(key, file, contentType);
      });
      if (added.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...added];
      setItems((prev) => [...prev, ...added]);
      for (const item of added) void run(item.key);
    },
    [run],
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

  React.useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);

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
