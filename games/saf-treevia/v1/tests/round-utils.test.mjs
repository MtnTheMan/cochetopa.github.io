import assert from "node:assert/strict";
import test from "node:test";

import { pickShuffledRound, questionMatchesSet } from "../round-utils.mjs";

test("Quizlet subset includes only attached A-tier cards and remains inside A tier", () => {
  const pdf = { tier: "A", quizletPdf: true };
  assert.equal(questionMatchesSet(pdf, "quizlet"), true);
  assert.equal(questionMatchesSet(pdf, "A"), true);
  assert.equal(questionMatchesSet({ tier: "A", quizletPdf: false }, "quizlet"), false);
  assert.equal(questionMatchesSet({ tier: "A" }, "quizlet"), false);
  assert.equal(questionMatchesSet({ tier: "Other", quizletPdf: true }, "quizlet"), false);
  assert.equal(questionMatchesSet(pdf, "local"), false);
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
