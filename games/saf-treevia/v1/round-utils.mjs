export function questionMatchesSet(question, set) {
  if (set === "local") return question.tier === "A" && question.localContext === true;
  if (set === "quizlet" || set === "quizlet_hard") return question.tier === "A" && question.quizletPdf === true;
  const tier = ["A", "B", "C", "Other"].includes(set) ? set : "A";
  return question.tier === tier;
}

export function questionPoolForSet(questions, { set = "A", mode = "mixed", category = "all" } = {}) {
  const hardMode = set === "quizlet_hard";
  return questions
    .filter((question) => questionMatchesSet(question, set))
    .filter((question) => category === "all" || question.category === category)
    .map((question) => {
      if (!hardMode) return question;
      const { choices, correctChoiceIndex, ...withoutChoices } = question;
      return { ...withoutChoices, format: "short_answer" };
    })
    .filter((question) => hardMode || mode === "mixed" || question.format === mode);
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
