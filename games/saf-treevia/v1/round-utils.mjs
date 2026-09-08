export function questionMatchesSet(question, set) {
  if (set === "local") return question.tier === "A" && question.localContext === true;
  if (set === "quizlet" || set === "quizlet_hard") return question.tier === "A" && question.quizletPdf === true;
  if (set === "neo") return question.tier === "B" && question.neoGenerated === true;
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

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function questionFingerprint(question) {
  return fnv1a(JSON.stringify([
    question?.id ?? "",
    question?.prompt ?? "",
    question?.answer ?? "",
    question?.format ?? "",
    question?.choices ?? [],
    question?.correctChoiceIndex ?? null,
  ]));
}

export function selectionSignature({ set = "A", category = "all", mode = "mixed" } = {}) {
  return [set, category, mode].map((value) => encodeURIComponent(String(value))).join("|");
}

export function unseenQuestions(values, seenFingerprints = {}) {
  if (!Array.isArray(values)) throw new TypeError("Question pool must be an array.");
  const seen = seenFingerprints && typeof seenFingerprints === "object" ? seenFingerprints : {};
  return values.filter((question) => seen[question.id] !== questionFingerprint(question));
}
