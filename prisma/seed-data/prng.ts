/**
 * Park-Miller "minimal standard" generator, exactly as the prototype's seedAdmin() (seed 42), so the admin sample
 * reproduces the prototype's customers, plans, dates and statuses. It is predictable by design: use it only to
 * shape sample data, never for license keys, tokens or anything secret (those use node:crypto).
 */
export type Prng = {
  /** Next value in (0, 1). */
  next(): number;
  /** Uniform pick, consuming one value. */
  pick<T>(items: readonly T[]): T;
};

const MODULUS = 2147483647;
const MULTIPLIER = 16807;

export function parkMiller(seed: number): Prng {
  if (!Number.isSafeInteger(seed) || seed <= 0 || seed >= MODULUS) {
    throw new RangeError(`Seed must be an integer in 1..${MODULUS - 1}`);
  }
  let state = seed;
  // state * 16807 stays below 2^46, so double arithmetic is exact.
  const next = () => {
    state = (state * MULTIPLIER) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new RangeError("Cannot pick from an empty list");
    return item;
  };
  return { next, pick };
}
