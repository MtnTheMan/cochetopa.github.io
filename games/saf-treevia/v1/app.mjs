import { evaluateShortAnswer, statusLabel } from "./answer-utils.mjs";

const ENVELOPE_FORMAT = "saf-treevia-encrypted-v1";
const PAYLOAD_SCHEMA_VERSION = 1;
const PAYLOAD_URL = "./questions.enc.json";

const byId = (id) => document.getElementById(id);

const elements = {
  gateView: byId("gate-view"),
  unlockForm: byId("unlock-form"),
  passwordInput: byId("password-input"),
  unlockButton: byId("unlock-button"),
  gateStatus: byId("gate-status"),
  gameView: byId("game-view"),
  lockButton: byId("lock-button"),
  setupPanel: byId("setup-panel"),
  questionPanel: byId("question-panel"),
  resultsPanel: byId("results-panel"),
  bankTotal: byId("bank-total"),
  roundForm: byId("round-form"),
  setSelect: byId("set-select"),
  setHelp: byId("set-help"),
  customTierFields: byId("custom-tier-fields"),
  categorySelect: byId("category-select"),
  roundSize: byId("round-size"),
  qualityWarning: byId("quality-warning"),
  availableCount: byId("available-count"),
  availableDetail: byId("available-detail"),
  startButton: byId("start-button"),
  progressLabel: byId("progress-label"),
  roundLabel: byId("round-label"),
  progressBar: byId("progress-bar"),
  endRoundButton: byId("end-round-button"),
  tierBadge: byId("tier-badge"),
  categoryBadge: byId("category-badge"),
  formatBadge: byId("format-badge"),
  questionPrompt: byId("question-prompt"),
  multipleChoiceArea: byId("multiple-choice-area"),
  choiceList: byId("choice-list"),
  shortAnswerForm: byId("short-answer-form"),
  shortAnswerInput: byId("short-answer-input"),
  checkAnswerButton: byId("check-answer-button"),
  answerInputStatus: byId("answer-input-status"),
  feedbackPanel: byId("feedback-panel"),
  feedbackIcon: byId("feedback-icon"),
  feedbackTitle: byId("feedback-title"),
  feedbackMessage: byId("feedback-message"),
  submittedAnswer: byId("submitted-answer"),
  expectedAnswer: byId("expected-answer"),
  sourceLabel: byId("source-label"),
  sourceLink: byId("source-link"),
  nextButton: byId("next-button"),
  scoreCorrect: byId("score-correct"),
  scoreClose: byId("score-close"),
  scoreMissed: byId("score-missed"),
  scorePoints: byId("score-points"),
  resultsTitle: byId("results-title"),
  resultsSummary: byId("results-summary"),
  resultPercent: byId("result-percent"),
  resultCorrect: byId("result-correct"),
  resultClose: byId("result-close"),
  resultMissed: byId("result-missed"),
  reviewListWrap: byId("review-list-wrap"),
  reviewList: byId("review-list"),
  retryButton: byId("retry-button"),
  newRoundButton: byId("new-round-button"),
};

const state = {
  bank: null,
  round: [],
  currentIndex: 0,
  results: [],
  answered: false,
  roundName: "Practice round",
};

class BankLoadError extends Error {}

function base64Bytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateEnvelope(envelope) {
  if (envelope?.format !== ENVELOPE_FORMAT) throw new Error("Unsupported question-bank envelope.");
  if (envelope?.kdf?.name !== "PBKDF2" || envelope.kdf.hash !== "SHA-256") throw new Error("Unsupported key derivation.");
  if (!Number.isInteger(envelope.kdf.iterations) || envelope.kdf.iterations < 100_000) throw new Error("Unsafe key derivation settings.");
  if (envelope?.cipher?.name !== "AES-GCM" || envelope.cipher.tagLength !== 128) throw new Error("Unsupported encryption settings.");
  if (!envelope.kdf.salt || !envelope.cipher.iv || !envelope.cipher.aad || !envelope.ciphertext) throw new Error("Incomplete encrypted bank.");
}

function validatePayload(payload) {
  if (payload?.schemaVersion !== PAYLOAD_SCHEMA_VERSION) throw new Error("This question bank needs a newer game version.");
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) throw new Error("The question bank is empty.");
  if (payload.questionCount !== payload.questions.length) throw new Error("The question bank is incomplete.");

  const ids = new Set();
  for (const question of payload.questions) {
    if (!question.id || ids.has(question.id)) throw new Error("The question bank contains duplicate IDs.");
    ids.add(question.id);
    if (!["A", "B", "C", "Other"].includes(question.tier)) throw new Error("The question bank contains an invalid tier.");
    if (!question.prompt || !question.answer || !question.category) throw new Error("The question bank contains an incomplete question.");
    if (question.format === "multiple_choice") {
      if (!Array.isArray(question.choices) || question.choices.length < 2) throw new Error("A multiple-choice item is incomplete.");
      if (!Number.isInteger(question.correctChoiceIndex) || !question.choices[question.correctChoiceIndex]) {
        throw new Error("A multiple-choice answer key is incomplete.");
      }
    } else if (question.format !== "short_answer") {
      throw new Error("The question bank contains an unsupported format.");
    }
  }
  return payload;
}

async function decryptBank(password) {
  let response;
  try {
    response = await fetch(PAYLOAD_URL, { cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new BankLoadError("The question bank could not be reached. Check your connection and try again.");
  }
  if (!response.ok) throw new BankLoadError("The question bank is temporarily unavailable. Please try again soon.");

  let envelope;
  try {
    envelope = await response.json();
    validateEnvelope(envelope);
  } catch {
    throw new BankLoadError("The question bank could not be loaded. Please try again soon.");
  }

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.trim()),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: envelope.kdf.hash,
      salt: base64Bytes(envelope.kdf.salt),
      iterations: envelope.kdf.iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64Bytes(envelope.cipher.iv),
      additionalData: encoder.encode(envelope.cipher.aad),
      tagLength: envelope.cipher.tagLength,
    },
    key,
    base64Bytes(envelope.ciphertext),
  );
  return validatePayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted)));
}

function setUnlockBusy(isBusy) {
  elements.unlockButton.disabled = isBusy;
  elements.passwordInput.disabled = isBusy;
  elements.unlockButton.textContent = isBusy ? "Unlocking…" : "Enter";
}

async function unlock(event) {
  event.preventDefault();
  const password = elements.passwordInput.value.trim();
  if (!password) {
    elements.gateStatus.textContent = "Enter the team password.";
    elements.passwordInput.focus();
    return;
  }

  setUnlockBusy(true);
  elements.gateStatus.textContent = "Opening the question bank…";
  try {
    state.bank = await decryptBank(password);
    elements.passwordInput.value = "";
    elements.gateStatus.textContent = "";
    elements.gateView.hidden = true;
    elements.gameView.hidden = false;
    elements.lockButton.hidden = false;
    elements.bankTotal.textContent = state.bank.questionCount.toLocaleString();
    refreshSetup({ rebuildCategories: true });
    showPanel("setup");
    elements.setSelect.focus();
  } catch (error) {
    if (error instanceof BankLoadError) {
      elements.gateStatus.textContent = error.message;
    } else {
      elements.gateStatus.textContent = "That password did not unlock the bank. Check the spacing and try again.";
    }
    elements.passwordInput.select();
  } finally {
    setUnlockBusy(false);
  }
}

function lockGame() {
  state.bank = null;
  state.round = [];
  state.results = [];
  state.currentIndex = 0;
  state.answered = false;
  elements.gameView.hidden = true;
  elements.gateView.hidden = false;
  elements.lockButton.hidden = true;
  elements.gateStatus.textContent = "The game is locked.";
  elements.passwordInput.value = "";
  elements.bankTotal.textContent = "—";
  elements.questionPrompt.textContent = "";
  elements.choiceList.replaceChildren();
  elements.shortAnswerInput.value = "";
  elements.submittedAnswer.textContent = "";
  elements.expectedAnswer.textContent = "";
  elements.sourceLabel.textContent = "";
  elements.sourceLink.removeAttribute("href");
  elements.feedbackPanel.hidden = true;
  elements.reviewList.replaceChildren();
  elements.reviewListWrap.hidden = true;
  elements.passwordInput.focus();
}

function checkedMode() {
  return elements.roundForm.querySelector('input[name="mode"]:checked')?.value ?? "mixed";
}

function selectedCustomTiers() {
  return [...elements.customTierFields.querySelectorAll('input[name="tier"]:checked')]
    .map((input) => input.value);
}

function selectedTiers() {
  switch (elements.setSelect.value) {
    case "A": return ["A"];
    case "AB": return ["A", "B"];
    case "all": return ["A", "B", "C", "Other"];
    case "custom": return selectedCustomTiers();
    default: return ["A", "B", "C", "Other"];
  }
}

function baseQuestionPool({ includeCategory = true } = {}) {
  if (!state.bank) return [];
  const set = elements.setSelect.value;
  const tiers = new Set(selectedTiers());
  const mode = checkedMode();
  const category = elements.categorySelect.value;

  return state.bank.questions.filter((question) => {
    if (set === "local") {
      if (!question.localContext || question.tier !== "A") return false;
    } else if (!tiers.has(question.tier)) {
      return false;
    }
    if (mode !== "mixed" && question.format !== mode) return false;
    if (includeCategory && category !== "all" && question.category !== category) return false;
    return true;
  });
}

function rebuildCategories() {
  const previous = elements.categorySelect.value;
  const categories = [...new Set(baseQuestionPool({ includeCategory: false }).map((question) => question.category))]
    .sort((left, right) => left.localeCompare(right));
  elements.categorySelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All subject areas";
  elements.categorySelect.append(allOption);
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    elements.categorySelect.append(option);
  }
  elements.categorySelect.value = categories.includes(previous) ? previous : "all";
}

function selectedSetIncludesLowerConfidence() {
  if (elements.setSelect.value === "all") return true;
  if (elements.setSelect.value !== "custom") return false;
  const tiers = selectedCustomTiers();
  return tiers.includes("C") || tiers.includes("Other");
}

function setDescription() {
  const descriptions = {
    local: "Washington and Tacoma questions for this year’s host-region context.",
    A: "Published, confirmed, or high-confidence material.",
    AB: "High-quality questions plus reputable supplemental sources.",
    all: "The full playable archive, including practice and review material.",
    custom: "Build your own combination of source-quality tiers.",
  };
  elements.setHelp.textContent = descriptions[elements.setSelect.value];
}

function refreshSetup({ rebuildCategories: shouldRebuildCategories = false } = {}) {
  if (!state.bank) return;
  elements.customTierFields.hidden = elements.setSelect.value !== "custom";
  setDescription();
  if (shouldRebuildCategories) rebuildCategories();

  const pool = baseQuestionPool();
  const multipleChoice = pool.filter((question) => question.format === "multiple_choice").length;
  const shortAnswer = pool.length - multipleChoice;
  elements.availableCount.textContent = `${pool.length.toLocaleString()} question${pool.length === 1 ? "" : "s"} available`;
  elements.availableDetail.textContent = `${multipleChoice.toLocaleString()} multiple choice · ${shortAnswer.toLocaleString()} short answer`;
  elements.startButton.disabled = pool.length === 0;

  const lowerConfidence = selectedSetIncludesLowerConfidence();
  elements.qualityWarning.hidden = !lowerConfidence;
  if (lowerConfidence) {
    elements.qualityWarning.textContent = "This selection includes generated, older, or less-reviewed archive material. Use the displayed source and expected answer when something deserves a closer look.";
  }
}

function randomIndex(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  const range = 0x1_0000_0000;
  const limit = range - (range % maxExclusive);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maxExclusive;
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function currentSetLabel() {
  return elements.setSelect.options[elements.setSelect.selectedIndex]?.textContent ?? "Practice";
}

function startRound(event) {
  event?.preventDefault();
  const pool = baseQuestionPool();
  if (!pool.length) return;
  const requestedSize = elements.roundSize.value === "all"
    ? pool.length
    : Number.parseInt(elements.roundSize.value, 10);
  const categoryLabel = elements.categorySelect.value === "all" ? "All subjects" : elements.categorySelect.value;
  const modeLabel = {
    mixed: "Mixed",
    multiple_choice: "Multiple choice",
    short_answer: "Short answer",
  }[checkedMode()];
  state.round = shuffled(pool).slice(0, Math.min(requestedSize, pool.length));
  state.currentIndex = 0;
  state.results = [];
  state.answered = false;
  state.roundName = `${currentSetLabel()} · ${categoryLabel} · ${modeLabel}`;
  showPanel("question");
  renderQuestion();
}

function showPanel(panelName) {
  elements.setupPanel.hidden = panelName !== "setup";
  elements.questionPanel.hidden = panelName !== "question";
  elements.resultsPanel.hidden = panelName !== "results";
}

function tierName(tier) {
  return tier === "Other" ? "Other" : `${tier} tier`;
}

function formatName(format) {
  return format === "multiple_choice" ? "Multiple choice" : "Short answer";
}

function renderQuestion() {
  const question = state.round[state.currentIndex];
  if (!question) {
    finishRound();
    return;
  }
  state.answered = false;
  elements.progressLabel.textContent = `Question ${state.currentIndex + 1} of ${state.round.length}`;
  elements.roundLabel.textContent = state.roundName;
  elements.progressBar.style.width = `${((state.currentIndex + 1) / state.round.length) * 100}%`;
  elements.tierBadge.textContent = tierName(question.tier);
  elements.categoryBadge.textContent = question.category;
  elements.formatBadge.textContent = formatName(question.format);
  elements.questionPrompt.textContent = question.prompt;
  elements.feedbackPanel.hidden = true;
  elements.feedbackPanel.removeAttribute("data-status");
  elements.answerInputStatus.textContent = "";
  elements.multipleChoiceArea.hidden = question.format !== "multiple_choice";
  elements.shortAnswerForm.hidden = question.format !== "short_answer";

  if (question.format === "multiple_choice") {
    renderChoices(question);
    requestAnimationFrame(() => elements.choiceList.querySelector("button")?.focus());
  } else {
    elements.shortAnswerInput.value = "";
    elements.shortAnswerInput.disabled = false;
    elements.checkAnswerButton.disabled = false;
    requestAnimationFrame(() => elements.shortAnswerInput.focus());
  }
  updateScore();
}

function renderChoices(question) {
  const options = shuffled(question.choices.map((text, originalIndex) => ({ text, originalIndex })));
  elements.choiceList.replaceChildren();
  options.forEach((option, displayIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.dataset.originalIndex = String(option.originalIndex);

    const key = document.createElement("span");
    key.className = "choice-key";
    key.textContent = String.fromCharCode(65 + displayIndex);
    key.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "choice-text";
    text.textContent = option.text;

    const result = document.createElement("span");
    result.className = "choice-result";
    result.setAttribute("aria-hidden", "true");

    button.append(key, text, result);
    button.setAttribute("aria-label", `${key.textContent}. ${option.text}`);
    button.addEventListener("click", () => answerMultipleChoice(button, question));
    elements.choiceList.append(button);
  });
}

function answerMultipleChoice(selectedButton, question) {
  if (state.answered) return;
  const selectedIndex = Number.parseInt(selectedButton.dataset.originalIndex, 10);
  const isCorrect = selectedIndex === question.correctChoiceIndex;
  const buttons = [...elements.choiceList.querySelectorAll("button")];
  for (const button of buttons) {
    button.disabled = true;
    const originalIndex = Number.parseInt(button.dataset.originalIndex, 10);
    const result = button.querySelector(".choice-result");
    if (originalIndex === question.correctChoiceIndex) {
      button.dataset.result = "correct";
      result.textContent = "Correct";
    } else if (button === selectedButton) {
      button.dataset.result = "incorrect";
      result.textContent = "Your choice";
    }
  }
  recordAnswer({
    status: isCorrect ? "correct" : "incorrect",
    submitted: question.choices[selectedIndex],
    points: isCorrect ? 1 : 0,
  });
}

function answerShort(event) {
  event.preventDefault();
  if (state.answered) return;
  const question = state.round[state.currentIndex];
  const submitted = elements.shortAnswerInput.value.trim();
  if (!submitted) {
    elements.answerInputStatus.textContent = "Enter an answer before checking it.";
    elements.shortAnswerInput.focus();
    return;
  }
  const evaluation = evaluateShortAnswer(submitted, question.answer);
  elements.shortAnswerInput.disabled = true;
  elements.checkAnswerButton.disabled = true;
  elements.answerInputStatus.textContent = "";
  recordAnswer({ status: evaluation.status, points: evaluation.score, submitted });
}

function feedbackCopy(status) {
  if (status === "correct") {
    return { icon: "✓", message: "That matches the answer key." };
  }
  if (status === "close") {
    return { icon: "≈", message: "You have part of it. Compare your wording with the expected answer." };
  }
  return { icon: "×", message: "Not this time. Read the expected answer, then try it again later." };
}

function sourceText(source) {
  const pieces = [source?.title, source?.year, source?.locator].filter(Boolean);
  return pieces.join(" · ") || "Source retained in the master question bank";
}

function recordAnswer({ status, submitted, points }) {
  if (state.answered) return;
  state.answered = true;
  const question = state.round[state.currentIndex];
  state.results.push({ question, status, submitted, points });
  const copy = feedbackCopy(status);
  elements.feedbackPanel.dataset.status = status;
  elements.feedbackIcon.textContent = copy.icon;
  elements.feedbackTitle.textContent = statusLabel(status);
  elements.feedbackMessage.textContent = copy.message;
  elements.submittedAnswer.textContent = submitted;
  elements.expectedAnswer.textContent = question.answer;
  elements.sourceLabel.textContent = sourceText(question.source);
  if (question.source?.url && /^https?:\/\//i.test(question.source.url)) {
    elements.sourceLink.href = question.source.url;
    elements.sourceLink.hidden = false;
  } else {
    elements.sourceLink.removeAttribute("href");
    elements.sourceLink.hidden = true;
  }
  elements.nextButton.textContent = state.currentIndex === state.round.length - 1 ? "See results" : "Next question";
  elements.feedbackPanel.hidden = false;
  updateScore();
  elements.feedbackTitle.tabIndex = -1;
  requestAnimationFrame(() => elements.feedbackTitle.focus({ preventScroll: false }));
}

function scoreSummary() {
  const correct = state.results.filter((result) => result.status === "correct").length;
  const close = state.results.filter((result) => result.status === "close").length;
  const missed = state.results.filter((result) => result.status === "incorrect").length;
  const points = state.results.reduce((sum, result) => sum + result.points, 0);
  return { correct, close, missed, points };
}

function formatPoints(points) {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

function updateScore() {
  const score = scoreSummary();
  elements.scoreCorrect.textContent = score.correct;
  elements.scoreClose.textContent = score.close;
  elements.scoreMissed.textContent = score.missed;
  elements.scorePoints.textContent = formatPoints(score.points);
}

function nextQuestion() {
  if (!state.answered) return;
  if (state.currentIndex >= state.round.length - 1) {
    finishRound();
    return;
  }
  state.currentIndex += 1;
  renderQuestion();
}

function finishRound() {
  if (!state.results.length) {
    showPanel("setup");
    refreshSetup({ rebuildCategories: true });
    elements.setSelect.focus();
    return;
  }
  const score = scoreSummary();
  const answered = state.results.length;
  const percent = Math.round((score.points / answered) * 100);
  const unfinished = state.round.length - answered;

  elements.resultPercent.textContent = `${percent}%`;
  elements.resultCorrect.textContent = score.correct;
  elements.resultClose.textContent = score.close;
  elements.resultMissed.textContent = score.missed;
  elements.resultsTitle.textContent = percent >= 90
    ? "Strong canopy coverage."
    : percent >= 70
      ? "You’re growing a solid stand."
      : "Good reconnaissance. Keep going.";
  elements.resultsSummary.textContent = unfinished > 0
    ? `You answered ${answered} of ${state.round.length} questions and earned ${formatPoints(score.points)} points. ${unfinished} unanswered question${unfinished === 1 ? " was" : "s were"} not scored.`
    : `You earned ${formatPoints(score.points)} of ${answered} possible points. Close answers receive half credit.`;

  const reviewItems = state.results.filter((result) => result.status !== "correct");
  elements.reviewList.replaceChildren();
  for (const item of reviewItems) {
    const listItem = document.createElement("li");
    const prompt = document.createElement("strong");
    prompt.textContent = item.question.prompt;
    const answer = document.createElement("span");
    answer.textContent = `Expected: ${item.question.answer}`;
    listItem.append(prompt, answer);
    elements.reviewList.append(listItem);
  }
  elements.reviewListWrap.hidden = reviewItems.length === 0;
  elements.retryButton.hidden = reviewItems.length === 0;
  elements.retryButton.textContent = `Retry missed + close${reviewItems.length ? ` (${reviewItems.length})` : ""}`;
  showPanel("results");
  elements.resultsTitle.tabIndex = -1;
  elements.resultsTitle.focus();
}

function retryMissed() {
  const reviewQuestions = state.results
    .filter((result) => result.status !== "correct")
    .map((result) => result.question);
  if (!reviewQuestions.length) return;
  state.round = shuffled(reviewQuestions);
  state.currentIndex = 0;
  state.results = [];
  state.answered = false;
  state.roundName = "Retry · missed + close";
  showPanel("question");
  renderQuestion();
}

function newRound() {
  state.round = [];
  state.results = [];
  state.currentIndex = 0;
  state.answered = false;
  showPanel("setup");
  refreshSetup({ rebuildCategories: true });
  elements.setSelect.focus();
}

function handleChoiceShortcut(event) {
  if (elements.questionPanel.hidden || state.answered) return;
  const question = state.round[state.currentIndex];
  if (question?.format !== "multiple_choice") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const match = event.key.toUpperCase().match(/^[A-F1-6]$/);
  if (!match) return;
  const displayIndex = /^[A-F]$/.test(match[0])
    ? match[0].charCodeAt(0) - 65
    : Number.parseInt(match[0], 10) - 1;
  const button = elements.choiceList.querySelectorAll("button")[displayIndex];
  if (button) {
    event.preventDefault();
    button.click();
  }
}

elements.unlockForm.addEventListener("submit", unlock);
elements.lockButton.addEventListener("click", lockGame);
elements.roundForm.addEventListener("submit", startRound);
elements.setSelect.addEventListener("change", () => refreshSetup({ rebuildCategories: true }));
elements.customTierFields.addEventListener("change", () => refreshSetup({ rebuildCategories: true }));
elements.categorySelect.addEventListener("change", () => refreshSetup());
elements.roundForm.addEventListener("change", (event) => {
  if (event.target.matches('input[name="mode"]')) refreshSetup({ rebuildCategories: true });
});
elements.shortAnswerForm.addEventListener("submit", answerShort);
elements.nextButton.addEventListener("click", nextQuestion);
elements.endRoundButton.addEventListener("click", finishRound);
elements.retryButton.addEventListener("click", retryMissed);
elements.newRoundButton.addEventListener("click", newRound);
document.addEventListener("keydown", handleChoiceShortcut);

elements.passwordInput.focus();
