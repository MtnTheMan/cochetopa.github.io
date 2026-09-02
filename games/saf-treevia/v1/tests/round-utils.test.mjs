import assert from "node:assert/strict";
import test from "node:test";

import { pickShuffledRound } from "../round-utils.mjs";

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
