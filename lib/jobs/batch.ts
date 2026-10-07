/**
 * The batching loop behind every maintenance task: run one bounded statement (or one bounded transaction) at a time,
 * so locks are short and no statement comes near the database statement timeout, and stop when the work is done, the
 * task's row cap for this run is reached, or its time budget is used up. Whatever is left is picked up by the next run
 * (every task is idempotent). Pure: no database access here.
 */

export type BatchStepResult = {
  /** Rows this batch looked at (selected and processed or skipped). Fewer than `limit` means nothing is left. */
  handled: number;
  /** Stop this task now and report it as unfinished (e.g. storage refused every delete of the batch). */
  stop?: boolean;
};

export type BatchStep = (limit: number) => Promise<BatchStepResult>;

export type BatchLimits = {
  /** Rows per batch (statement LIMIT). */
  batchSize: number;
  /** Most rows this task handles in one run. */
  maxRows: number;
  /** Time (on `clock`) after which no new batch starts. A batch that is running is never interrupted. */
  deadline: number;
  /** Milliseconds clock (default Date.now). */
  clock?: () => number;
};

export type BatchOutcome = {
  /** Sum of `handled` over all batches. */
  handled: number;
  batches: number;
  /** True when the task stopped early (row cap, time budget or `stop`) and may have work left for the next run. */
  more: boolean;
};

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive whole number`);
  return value;
}

/** Runs `step` in batches until a batch comes back short, or a limit is reached (see BatchLimits). */
export async function runBatches(step: BatchStep, limits: BatchLimits): Promise<BatchOutcome> {
  const batchSize = positiveInt(limits.batchSize, "batchSize");
  const maxRows = positiveInt(limits.maxRows, "maxRows");
  const clock = limits.clock ?? Date.now;
  let handled = 0;
  let batches = 0;
  for (;;) {
    const room = maxRows - handled;
    if (room <= 0 || clock() >= limits.deadline) return { handled, batches, more: true };
    const limit = Math.min(batchSize, room);
    const result = await step(limit);
    const count = Math.max(0, Math.floor(result.handled));
    batches += 1;
    handled += count;
    if (result.stop) return { handled, batches, more: true };
    if (count < limit) return { handled, batches, more: false };
  }
}
