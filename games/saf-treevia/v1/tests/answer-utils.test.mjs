import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateShortAnswer,
  normalizeAnswer,
  parseListKey,
} from "../answer-utils.mjs";

test("normalizes case, spacing, common units, and magnitude shorthand", () => {
  assert.equal(normalizeAnswer("  22M   ACRES  "), "22 million acres");
  assert.equal(evaluateShortAnswer("4.5 ft", "4.5 feet").status, "correct");
});

test("accepts exact answers and one-character typos conservatively", () => {
  assert.equal(evaluateShortAnswer("Western Hemlock", "western hemlock").status, "correct");
  assert.equal(evaluateShortAnswer("cambiun", "cambium").status, "correct");
  assert.equal(evaluateShortAnswer("hemlock", "western hemlock").status, "close");
  assert.equal(evaluateShortAnswer("western redcedar", "western hemlock").status, "incorrect");
});

test("requires exact numeric facts and respects negation", () => {
  assert.equal(evaluateShortAnswer("about 22m acres", "About 22 million acres").status, "correct");
  assert.equal(evaluateShortAnswer("5 feet", "4.5 feet").status, "incorrect");
  assert.equal(evaluateShortAnswer("a hardwood", "not a hardwood").status, "incorrect");
});

test("parses explicit Any two and Any three answer keys", () => {
  assert.deepEqual(
    parseListKey("Any two: drought; wildfire; insect and disease outbreaks"),
    {
      required: 2,
      components: ["drought", "wildfire", "insect and disease outbreaks"],
    },
  );
  assert.equal(parseListKey("Western hemlock"), null);
});

test("grades list keys by complete components, not arbitrary token overlap", () => {
  const anyTwo = "Any two: drought; wildfire; insect and disease outbreaks; forest conversion";
  assert.equal(evaluateShortAnswer("drought and wildfire", anyTwo).status, "correct");
  assert.equal(evaluateShortAnswer("drought", anyTwo).status, "close");
  assert.equal(evaluateShortAnswer("forest", anyTwo).status, "incorrect");

  const anyThree = "Any three of the following: western redcedar; western hemlock; western white pine; Douglas-fir";
  assert.equal(
    evaluateShortAnswer("western redcedar, western hemlock, and Douglas-fir", anyThree).status,
    "correct",
  );
  assert.equal(evaluateShortAnswer("western redcedar and Douglas-fir", anyThree).status, "close");
  assert.equal(evaluateShortAnswer("western", anyThree).status, "incorrect");
});

test("blank and unrelated responses are incorrect", () => {
  assert.equal(evaluateShortAnswer("", "cambium").status, "incorrect");
  assert.equal(evaluateShortAnswer("photosynthesis", "cambium").status, "incorrect");
});
