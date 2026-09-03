import assert from "node:assert/strict";
import test from "node:test";

import { pickShuffledRound, questionMatchesSet, questionPoolForSet } from "../round-utils.mjs";

test("Quizlet subset includes only attached A-tier cards and remains inside A tier", () => {
  const pdf = { tier: "A", quizletPdf: true };
  assert.equal(questionMatchesSet(pdf, "quizlet"), true);
  assert.equal(questionMatchesSet(pdf, "quizlet_hard"), true);
  assert.equal(questionMatchesSet(pdf, "A"), true);
  assert.equal(questionMatchesSet({ tier: "A", quizletPdf: false }, "quizlet"), false);
  assert.equal(questionMatchesSet({ tier: "A" }, "quizlet"), false);
  assert.equal(questionMatchesSet({ tier: "Other", quizletPdf: true }, "quizlet"), false);
  assert.equal(questionMatchesSet(pdf, "local"), false);
});

const quizletFixture = [
  { id: "pdf-mc", tier: "A", quizletPdf: true, category: "Soils", prompt: "Soil question", answer: "Soil answer", format: "multiple_choice", choices: ["Soil answer", "Wrong"], correctChoiceIndex: 0 },
  { id: "pdf-sa", tier: "A", quizletPdf: true, category: "Fire", prompt: "Fire question", answer: "Fire answer", format: "short_answer" },
  { id: "other-a", tier: "A", quizletPdf: false, category: "Fire", format: "short_answer" },
];

test("hard mode contains the exact same Quizlet IDs, prompts, and keys without mutating mixed questions", () => {
  const before = structuredClone(quizletFixture);
  const mixed = questionPoolForSet(quizletFixture, { set: "quizlet" });
  const hard = questionPoolForSet(quizletFixture, { set: "quizlet_hard" });
  assert.equal(mixed.length, 2);
  assert.deepEqual(hard.map(q => [q.id, q.prompt, q.answer]), mixed.map(q => [q.id, q.prompt, q.answer]));
  assert.ok(hard.every(q => q.format === "short_answer" && !('choices' in q) && !('correctChoiceIndex' in q)));
  assert.deepEqual(quizletFixture, before);
  assert.equal(mixed[0].format, "multiple_choice");
});

test("hard mode applies category filters but never loses MC-origin questions to mode filtering", () => {
  const hard = questionPoolForSet(quizletFixture, { set: "quizlet_hard", mode: "multiple_choice", category: "Soils" });
  assert.equal(hard.length, 1);
  assert.equal(hard[0].id, "pdf-mc");
  assert.equal(hard[0].format, "short_answer");
  assert.equal(questionPoolForSet(quizletFixture, { set: "quizlet", mode: "short_answer" }).length, 1);
  assert.equal(questionPoolForSet(quizletFixture, { set: "quizlet", mode: "multiple_choice" }).length, 1);
});

test("hard-mode shuffled rounds and retries preserve the free-response form", () => {
  const pool = questionPoolForSet(quizletFixture, { set: "quizlet_hard" });
  const round = pickShuffledRound(pool, 2, q => q.reverse());
  const retry = pickShuffledRound(round.filter(q => q.id === "pdf-mc"), 1, q => q);
  assert.equal(round[0].id, "pdf-sa");
  assert.equal(retry[0].format, "short_answer");
  assert.equal(retry[0].answer, "Soil answer");
});

test("tier and Washington subsets preserve their existing boundaries", () => {
  assert.equal(questionMatchesSet({ tier: "A", localContext: true }, "local"), true);
  assert.equal(questionMatchesSet({ tier: "B", localContext: true }, "local"), false);
  for (const tier of ["A", "B", "C", "Other"]) {
    assert.equal(questionMatchesSet({ tier }, tier), true);
    assert.equal(questionMatchesSet({ tier }, "unknown"), tier === "A");
  }
});

test("round selection shuffles the full eligible pool before taking the requested size", () => {
  const pool = ["Q1", "Q2", "Q3", "Q4", "Q5"];
  const selected = pickShuffledRound(pool, 2, (values) => values.reverse());
  assert.deepEqual(selected, ["Q5", "Q4"]);
  assert.deepEqual(pool, ["Q1", "Q2", "Q3", "Q4", "Q5"]);
});

test("round selection caps the request at the available pool", () => {
  const selected = pickShuffledRound(["Q1", "Q2"], 20, (values) => values);
  assert.deepEqual(selected, ["Q1", "Q2"]);
});
