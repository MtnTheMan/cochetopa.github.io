// Small state-in/state-out PRNG helpers. Keeping the state as one uint32 makes
// simulation snapshots portable and avoids hidden closure state.

const ZERO_SEED_FALLBACK = 0x6d2b79f5;

export function normalizeSeed(seed) {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("Simulation seed must be an explicit safe integer.");
  }

  const normalized = seed >>> 0;
  return normalized === 0 ? ZERO_SEED_FALLBACK : normalized;
}

export function nextRandom(rngState) {
  let nextState = rngState >>> 0;
  if (nextState === 0) nextState = ZERO_SEED_FALLBACK;

  // xorshift32: deterministic with a period of 2^32 - 1 for non-zero state.
  nextState ^= nextState << 13;
  nextState ^= nextState >>> 17;
  nextState ^= nextState << 5;
  nextState >>>= 0;

  return {
    rngState: nextState,
    value: nextState / 0x100000000,
  };
}
