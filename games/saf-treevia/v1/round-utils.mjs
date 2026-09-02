export function pickShuffledRound(values, requestedSize, shuffleFn) {
  if (!Array.isArray(values)) throw new TypeError("Question pool must be an array.");
  if (typeof shuffleFn !== "function") throw new TypeError("A shuffle function is required.");
  const size = Number.isFinite(requestedSize)
    ? Math.max(0, Math.floor(requestedSize))
    : values.length;
  const randomizedPool = shuffleFn([...values]);
  return randomizedPool.slice(0, Math.min(size, randomizedPool.length));
}
