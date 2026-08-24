const textEncoder = new TextEncoder();

function assertCanonicalValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must not contain a non-finite number`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must not contain an unsafe integer`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalValue(item, `${path}[${index}]`));
    return;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      assertCanonicalValue(value[key], `${path}.${key}`);
    }
    return;
  }

  throw new TypeError(`${path} contains unsupported canonical JSON value ${typeof value}`);
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function canonicalStringify(value) {
  assertCanonicalValue(value);
  return JSON.stringify(sortValue(value));
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
