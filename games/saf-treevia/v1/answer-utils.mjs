const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "per", "that", "the", "their", "to", "was",
  "were", "which", "with",
]);

const NEGATIONS = new Set(["no", "not", "never", "neither", "none", "without"]);

const FRACTIONS = new Map([
  ["½", ".5"],
  ["¼", ".25"],
  ["¾", ".75"],
  ["⅓", ".333"],
  ["⅔", ".667"],
]);

const TOKEN_EQUIVALENTS = new Map([
  ["ft", "foot"],
  ["feet", "foot"],
  ["in", "inch"],
  ["inches", "inch"],
  ["yrs", "year"],
  ["yr", "year"],
  ["years", "year"],
  ["ac", "acre"],
  ["acres", "acre"],
  ["pct", "percent"],
  ["percentage", "percent"],
  ["wildfires", "wildfire"],
  ["diseases", "disease"],
  ["insects", "insect"],
]);

const NUMBER_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
]);

/** Normalize punctuation, common forestry units, and whitespace for answer comparison. */
export function normalizeAnswer(value) {
  let text = String(value ?? "").trim();

  for (const [fraction, decimal] of FRACTIONS) {
    text = text.replaceAll(fraction, decimal);
  }

  text = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d)\s*['′]\b/g, "$1 feet")
    .replace(/(\d)\s*["″]\b/g, "$1 inches")
    .replace(/\b(\d+(?:\.\d+)?)\s*m\b/g, "$1 million")
    .replace(/\bapproximately\b|\bapprox\.?\b|\baround\b/g, "about")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.+'-]+/g, " ")
    .replace(/(^|\s)[.'+-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function canonicalToken(token) {
  const direct = TOKEN_EQUIVALENTS.get(token);
  if (direct) return direct;
  if (/^[0-9.]+$/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function answerTokens(value, { informative = false } = {}) {
  const tokens = normalizeAnswer(value)
    .split(" ")
    .filter(Boolean)
    .map(canonicalToken);
  return informative ? tokens.filter((token) => !STOP_WORDS.has(token)) : tokens;
}

function unique(values) {
  return [...new Set(values)];
}

/** Return conservative aliases that are explicitly present in the canonical answer. */
export function expectedVariants(expected) {
  const raw = String(expected ?? "").trim();
  const variants = [raw];

  const withoutApproximation = raw.replace(/^\s*(?:about|approximately|around)\s+/i, "");
  if (withoutApproximation !== raw) variants.push(withoutApproximation);

  const parenthetical = raw.match(/^\s*([^()]{2,80})\s*\(([^()]{2,60})\)\s*[.;]?\s*$/);
  if (parenthetical) {
    const outside = parenthetical[1].trim();
    const inside = parenthetical[2].trim();
    const bothAreShort = answerTokens(outside, { informative: true }).length <= 6
      && answerTokens(inside, { informative: true }).length <= 6;
    const neitherLooksLikeExplanation = !/[,:;]/.test(inside) && !/\d/.test(inside);
    if (bothAreShort && neitherLooksLikeExplanation) variants.push(outside, inside);
  }

  const alternateParts = raw.split(/\s+(?:also (?:called|known as)|or)\s+|\s*\/\s*/i);
  if (
    alternateParts.length > 1
    && alternateParts.length <= 4
    && alternateParts.every((part) => answerTokens(part, { informative: true }).length <= 6)
  ) {
    variants.push(...alternateParts);
  }

  const firstClause = raw.split(/;|\.(?:\s|$)/, 1)[0].trim();
  if (
    firstClause
    && firstClause !== raw
    && answerTokens(firstClause, { informative: true }).length <= 8
  ) {
    variants.push(firstClause);
  }

  return unique(variants.map(normalizeAnswer).filter(Boolean));
}

function stripListPrefix(value) {
  return String(value ?? "").replace(
    /^\s*(?:(?:any|name|list|identify|give|provide)\s+)?(?:one|two|three|four|five|[1-5])(?:\s+(?:of\s+)?(?:the\s+following\s*)?)?\s*[:\-]\s*/i,
    "",
  );
}

/** Parse explicit answer keys such as `Any two: drought; wildfire; insects`. */
export function parseListKey(expected) {
  const raw = String(expected ?? "").trim();
  const match = raw.match(
    /^\s*(?:(?:any|name|list|identify|give|provide)\s+)?(one|two|three|four|five|[1-5])(?:\s+(?:of\s+)?(?:the\s+following\s*)?)?\s*[:\-]\s*(.+)$/i,
  );
  if (!match) return null;
  const required = NUMBER_WORDS.get(match[1].toLowerCase()) ?? Number.parseInt(match[1], 10);
  const components = match[2].split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
  if (!Number.isInteger(required) || required < 1 || components.length < required) return null;
  return { required, components };
}

function componentMatchesGiven(component, given) {
  const givenTokens = new Set(answerTokens(given, { informative: true }));
  for (const variant of expectedVariants(component)) {
    const componentTokens = unique(answerTokens(variant, { informative: true }));
    if (componentTokens.length && componentTokens.every((token) => givenTokens.has(token))) return true;
    if (componentTokens.length === 1 && componentTokens[0].length >= 5) {
      const typoMatch = [...givenTokens].some((token) => levenshteinDistance(componentTokens[0], token) <= 1);
      if (typoMatch) return true;
    }
  }
  return false;
}

export function levenshteinDistance(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function editSimilarity(left, right) {
  const a = normalizeAnswer(left);
  const b = normalizeAnswer(right);
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - (levenshteinDistance(a, b) / longest);
}

function scaledNumbers(value) {
  const normalized = normalizeAnswer(value);
  const matches = normalized.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?(?:\s+(?:thousand|million|billion))?/g);
  return [...matches].map((match) => {
    const raw = match[0].replaceAll(",", "");
    const numeric = Number.parseFloat(raw);
    if (raw.includes("billion")) return numeric * 1_000_000_000;
    if (raw.includes("million")) return numeric * 1_000_000;
    if (raw.includes("thousand")) return numeric * 1_000;
    return numeric;
  }).filter(Number.isFinite);
}

function numbersMatch(expectedNumbers, givenNumbers) {
  if (expectedNumbers.length !== givenNumbers.length) return false;
  return expectedNumbers.every((expected, index) => {
    const given = givenNumbers[index];
    const tolerance = Math.max(1e-8, Math.abs(expected) * 1e-8);
    return Math.abs(expected - given) <= tolerance;
  });
}

function tokenMetrics(given, expected) {
  const expectedSet = new Set(answerTokens(expected, { informative: true }));
  const givenSet = new Set(answerTokens(given, { informative: true }));
  const intersection = [...expectedSet].filter((token) => givenSet.has(token)).length;
  const coverage = expectedSet.size ? intersection / expectedSet.size : 0;
  const precision = givenSet.size ? intersection / givenSet.size : 0;
  const f1 = coverage + precision ? (2 * coverage * precision) / (coverage + precision) : 0;
  return { coverage, precision, f1, expectedSize: expectedSet.size, givenSize: givenSet.size };
}

function hasNegationMismatch(given, expected) {
  const givenNegations = answerTokens(given).filter((token) => NEGATIONS.has(token));
  const expectedNegations = answerTokens(expected).filter((token) => NEGATIONS.has(token));
  return Boolean(givenNegations.length) !== Boolean(expectedNegations.length);
}

/**
 * Conservatively grade a free-response answer.
 *
 * `correct` is reserved for exact answers, small obvious typos, exact numeric
 * equivalents, and very high token coverage. `close` is a review signal rather
 * than a claim of correctness; the canonical answer is always shown by the UI.
 */
export function evaluateShortAnswer(given, expected) {
  const normalizedGiven = normalizeAnswer(given);
  const listKey = parseListKey(expected);
  if (listKey) {
    const givenHasNegation = answerTokens(normalizedGiven).some((token) => NEGATIONS.has(token));
    const expectedHasNegation = answerTokens(expected).some((token) => NEGATIONS.has(token));
    if (givenHasNegation !== expectedHasNegation) {
      return { status: "incorrect", score: 0, reason: "negation-mismatch" };
    }
    const matchedComponents = listKey.components.filter((component) => componentMatchesGiven(component, normalizedGiven));
    if (matchedComponents.length >= listKey.required) {
      return {
        status: "correct",
        score: 1,
        reason: "list-requirement-met",
        matchedComponents: matchedComponents.length,
        requiredComponents: listKey.required,
      };
    }
    if (matchedComponents.length > 0) {
      return {
        status: "close",
        score: 0.5,
        reason: "list-partial",
        matchedComponents: matchedComponents.length,
        requiredComponents: listKey.required,
      };
    }
    return {
      status: "incorrect",
      score: 0,
      reason: "list-no-match",
      matchedComponents: 0,
      requiredComponents: listKey.required,
    };
  }

  const gradingExpected = stripListPrefix(expected);
  const normalizedExpected = normalizeAnswer(gradingExpected);
  if (!normalizedGiven) return { status: "incorrect", score: 0, reason: "blank" };
  if (!normalizedExpected) return { status: "incorrect", score: 0, reason: "missing-key" };

  const variants = expectedVariants(gradingExpected);
  if (variants.includes(normalizedGiven)) {
    return { status: "correct", score: 1, reason: "exact" };
  }

  if (hasNegationMismatch(normalizedGiven, normalizedExpected)) {
    return { status: "incorrect", score: 0, reason: "negation-mismatch" };
  }

  let best = { similarity: 0, metrics: tokenMetrics(normalizedGiven, normalizedExpected), variant: normalizedExpected };
  for (const variant of variants) {
    const similarity = editSimilarity(normalizedGiven, variant);
    const metrics = tokenMetrics(normalizedGiven, variant);
    const rank = Math.max(similarity, metrics.f1, metrics.coverage * 0.95);
    const bestRank = Math.max(best.similarity, best.metrics.f1, best.metrics.coverage * 0.95);
    if (rank > bestRank) best = { similarity, metrics, variant };
  }

  const expectedNumbers = scaledNumbers(best.variant);
  const givenNumbers = scaledNumbers(normalizedGiven);
  if (expectedNumbers.length) {
    if (numbersMatch(expectedNumbers, givenNumbers)) {
      const wordsExpected = answerTokens(best.variant, { informative: true })
        .filter((token) => !/^\d/.test(token) && !["thousand", "million", "billion"].includes(token));
      const substantiveWords = wordsExpected.filter((token) => !["about", "approximately", "foot", "inch", "acre", "percent", "year"].includes(token));
      if (!substantiveWords.length || best.metrics.coverage >= 0.78 || best.similarity >= 0.88) {
        return { status: "correct", score: 1, reason: "numeric-equivalent" };
      }
      return { status: "close", score: 0.5, reason: "numeric-match-partial-words" };
    }

    const someNumberMatches = expectedNumbers.some((number) => givenNumbers.some((givenNumber) => number === givenNumber));
    if (!someNumberMatches) {
      return { status: "incorrect", score: 0, reason: "numeric-mismatch" };
    }
  }

  const expectedTokens = answerTokens(best.variant, { informative: true });
  const givenTokens = answerTokens(normalizedGiven, { informative: true });
  if (
    expectedTokens.length === 1
    && givenTokens.length === 1
    && expectedTokens[0].length >= 5
  ) {
    const distance = levenshteinDistance(expectedTokens[0], givenTokens[0]);
    if (distance <= 1) return { status: "correct", score: 1, reason: "minor-typo" };
    if (distance === 2) return { status: "close", score: 0.5, reason: "possible-typo" };
  }

  const { coverage, precision, f1, expectedSize } = best.metrics;
  if (
    best.similarity >= 0.94
    || (coverage === 1 && precision >= 0.75 && expectedSize <= 10)
    || (coverage >= 0.9 && f1 >= 0.84)
  ) {
    return { status: "correct", score: 1, reason: "high-confidence-fuzzy" };
  }

  if (
    best.similarity >= 0.72
    || f1 >= 0.62
    || coverage >= 0.55
    || (normalizedExpected.includes(normalizedGiven) && normalizedGiven.length >= 4)
  ) {
    return { status: "close", score: 0.5, reason: "partial-match" };
  }

  return { status: "incorrect", score: 0, reason: "low-similarity" };
}

export function statusLabel(status) {
  if (status === "correct") return "Correct";
  if (status === "close") return "Close. Review the answer.";
  return "Not quite";
}
