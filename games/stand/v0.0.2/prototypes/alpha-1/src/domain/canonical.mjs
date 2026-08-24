const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function checksumJson(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = FNV_OFFSET_64;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export function canonicalByteLength(value) {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function assertJsonValue(value, path = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be finite.`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must not contain an unsafe JSON integer.`);
    }
    return;
  }
  if (typeof value !== "object" || Array.isArray(value) && value.some(() => false)) {
    throw new TypeError(`${path} is not JSON-safe.`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} contains a cycle.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) {
        throw new TypeError(`${path}.${key} must not be undefined.`);
      }
      assertJsonValue(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function compareUtf8(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(String(left));
  const rightBytes = encoder.encode(String(right));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function quantize(value, quantum = 1e-9) {
  if (!Number.isFinite(value)) throw new TypeError("Cannot quantize a non-finite value.");
  if (!Number.isFinite(quantum) || quantum <= 0) {
    throw new TypeError("Quantum must be finite and positive.");
  }
  const rounded = Math.round(value / quantum) * quantum;
  const decimalPlaces = Math.max(0, Math.min(100, Math.ceil(-Math.log10(quantum))));
  return Number(rounded.toFixed(decimalPlaces));
}

function canonicalize(value) {
  assertJsonValue(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}
