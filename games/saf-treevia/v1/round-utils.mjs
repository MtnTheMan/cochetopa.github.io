export function questionMatchesSet(question, set) {
  if (set === "local") return question.tier === "A" && question.localContext === true;
  if (set === "quizlet") return question.tier === "A" && question.quizletPdf === true;
  const tier = ["A", "B", "C", "Other"].includes(set) ? set : "A";
  return question.tier === tier;
}

export function pickShuffledRound(values, requestedSize, shuffleFn) {
  if (!Array.isArray(values)) throw new TypeError("Question pool must be an array.");
  if (typeof shuffleFn !== "function") throw new TypeError("A shuffle function is required.");
  const size = Number.isFinite(requestedSize)
    ? Math.max(0, Math.floor(requestedSize))
    : values.length;
  const randomizedPool = shuffleFn([...values]);
  return randomizedPool.slice(0, Math.min(size, randomizedPool.length));
}
