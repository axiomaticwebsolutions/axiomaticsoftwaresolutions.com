/**
 * The maintenance batching loop (lib/jobs/batch.ts): bounded batches until a short batch, the per-run row cap, the
 * time budget or an explicit stop.
 */
import { describe, expect, it } from "vitest";
import { runBatches, type BatchStep } from "@/lib/jobs/batch";

/** A step over `total` rows: hands out up to `limit` per call and records the limits it was given. */
function rows(total: number): { step: BatchStep; limits: number[]; left: () => number } {
  let left = total;
  const limits: number[] = [];
  return {
    limits,
    left: () => left,
    step: async (limit) => {
      limits.push(limit);
      const n = Math.min(limit, left);
      left -= n;
      return { handled: n };
    },
  };
}

const far = Number.MAX_SAFE_INTEGER;

describe("runBatches", () => {
  it("loops until a batch comes back short", async () => {
    const r = rows(7);
    expect(await runBatches(r.step, { batchSize: 3, maxRows: 100, deadline: far })).toEqual({ handled: 7, batches: 3, more: false });
    expect(r.limits).toEqual([3, 3, 3]);
  });

  it("needs one extra empty batch when the rows divide evenly, and one batch when there is nothing", async () => {
    const even = rows(6);
    expect(await runBatches(even.step, { batchSize: 3, maxRows: 100, deadline: far })).toEqual({ handled: 6, batches: 3, more: false });
    const none = rows(0);
    expect(await runBatches(none.step, { batchSize: 3, maxRows: 100, deadline: far })).toEqual({ handled: 0, batches: 1, more: false });
  });

  it("never exceeds the per-run row cap (the last batch shrinks) and reports more", async () => {
    const r = rows(10);
    expect(await runBatches(r.step, { batchSize: 3, maxRows: 7, deadline: far })).toEqual({ handled: 7, batches: 3, more: true });
    expect(r.limits).toEqual([3, 3, 1]);
    expect(r.left()).toBe(3);
    // The next run continues where this one stopped.
    expect(await runBatches(r.step, { batchSize: 3, maxRows: 7, deadline: far })).toEqual({ handled: 3, batches: 2, more: false });
  });

  it("starts no batch after the deadline, but never interrupts a running one", async () => {
    let t = 0;
    const clock = () => t;
    const r = rows(100);
    const slow: BatchStep = async (limit) => {
      t += 40;
      return r.step(limit);
    };
    expect(await runBatches(slow, { batchSize: 5, maxRows: 100, deadline: 100, clock })).toEqual({ handled: 15, batches: 3, more: true });
    expect(t).toBe(120);
    expect(await runBatches(r.step, { batchSize: 5, maxRows: 100, deadline: 120, clock })).toEqual({ handled: 0, batches: 0, more: true });
  });

  it("stops at once when a step asks to, and reports more", async () => {
    const calls: number[] = [];
    const step: BatchStep = async (limit) => {
      calls.push(limit);
      return { handled: limit, stop: calls.length === 2 };
    };
    expect(await runBatches(step, { batchSize: 4, maxRows: 100, deadline: far })).toEqual({ handled: 8, batches: 2, more: true });
  });

  it("propagates a failing step", async () => {
    const step: BatchStep = async () => {
      throw new Error("boom");
    };
    await expect(runBatches(step, { batchSize: 4, maxRows: 100, deadline: far })).rejects.toThrow("boom");
  });

  it("rejects nonsensical limits", async () => {
    const r = rows(1);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(runBatches(r.step, { batchSize: bad, maxRows: 10, deadline: far })).rejects.toThrow(RangeError);
      await expect(runBatches(r.step, { batchSize: 10, maxRows: bad, deadline: far })).rejects.toThrow(RangeError);
    }
  });
});
