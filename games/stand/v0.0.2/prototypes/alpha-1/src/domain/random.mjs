import { quantize } from "./canonical.mjs";

export const RANDOM_ALGORITHM = "stand-keyed-fnv32-v1";
export const RANDOM_DERIVATION = "master-seed/stream/process-key";

export const RANDOM_STREAMS = Object.freeze([
  "dispersal",
  "germination",
  "establishment",
  "recruit-survival",
  "growth",
  "mortality",
  "reproduction",
  "refinement",
]);

export function createRandomLedger(masterSeed) {
  if (!Number.isSafeInteger(masterSeed)) {
    throw new TypeError("masterSeed must be a safe integer.");
  }
  return {
    algorithm: RANDOM_ALGORITHM,
    derivation: RANDOM_DERIVATION,
    masterSeed,
    drawCounts: Object.fromEntries(RANDOM_STREAMS.map((name) => [name, 0])),
  };
}

export function drawUnit(state, streamName, ...processKey) {
  requireLedger(state, streamName);
  const key = [state.random.masterSeed, streamName, ...processKey].join("\u001f");
  state.random.drawCounts[streamName] += 1;
  return quantize(hashText32(key) / 0x1_0000_0000, 1e-12);
}

export function stochasticRound(state, streamName, expected, ...processKey) {
  if (!Number.isFinite(expected) || expected < 0) {
    throw new TypeError("expected count must be finite and nonnegative.");
  }
  const whole = Math.floor(expected);
  const fraction = expected - whole;
  if (fraction <= 0) return whole;
  return whole + (drawUnit(state, streamName, ...processKey) < fraction ? 1 : 0);
}

export function deterministicSpread(state, streamName, count, ...processKey) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push(drawUnit(state, streamName, ...processKey, index));
  }
  return results;
}

export function validateRandomLedger(ledger) {
  requireLedger(ledger ? { random: ledger } : null);
  for (const name of RANDOM_STREAMS) {
    const count = ledger.drawCounts[name];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`random.drawCounts.${name} must be a nonnegative safe integer.`);
    }
  }
  return true;
}

function requireLedger(state, streamName = null) {
  const ledger = state?.random;
  if (!ledger || ledger.algorithm !== RANDOM_ALGORITHM || ledger.derivation !== RANDOM_DERIVATION) {
    throw new RangeError("Unsupported or missing random-stream ledger.");
  }
  if (!Number.isSafeInteger(ledger.masterSeed)) {
    throw new TypeError("Random ledger masterSeed must be a safe integer.");
  }
  if (!ledger.drawCounts || typeof ledger.drawCounts !== "object") {
    throw new TypeError("Random ledger drawCounts are required.");
  }
  if (streamName && !RANDOM_STREAMS.includes(streamName)) {
    throw new RangeError(`Unknown ecological random stream: ${streamName}`);
  }
}

function hashText32(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}
