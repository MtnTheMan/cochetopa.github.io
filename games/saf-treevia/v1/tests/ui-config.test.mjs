import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(testDir, "..", "index.html"), "utf8");
const app = fs.readFileSync(path.resolve(testDir, "..", "app.mjs"), "utf8");
const wrapper = fs.readFileSync(path.resolve(testDir, "../../../..", "_games", "saf-treevia.html"), "utf8");

test("question sets default to A tier and follow the requested sequence", () => {
  const select = html.match(/<select id="set-select"[\s\S]*?<\/select>/)?.[0] ?? "";
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["A", "local", "quizlet", "quizlet_hard", "neo", "B", "C", "Other"]);
  assert.match(select, /<option value="A" selected>/);
  assert.doesNotMatch(html, /id="custom-tier-fields"/);
});

test("every app DOM reference exists in the page", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const references = [...app.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(references.filter((id) => !ids.has(id)), []);
});

test("source cautions are shown safely with immediate answer feedback", () => {
  assert.match(html, /id="review-caution"[^>]*hidden/);
  assert.match(app, /elements\.reviewCaution\.textContent = question\.reviewFlag/);
  assert.match(app, /elements\.reviewCaution\.hidden = !question\.reviewFlag/);
  assert.doesNotMatch(app, /reviewCaution\.innerHTML/);
});

test("setup explains and controls device-local no-repeat history", () => {
  assert.match(html, /id="history-note"[^>]*aria-live="polite"/);
  assert.match(html, /id="reset-history-button"/);
  assert.match(app, /saf-treevia-question-history-v1/);
  assert.match(app, /unseenQuestions\(fullPool/);
  assert.match(app, /markQuestionSeen\(question\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*(?:password|answer|prompt)/i);
});

test("page and module imports share the fresh release cache version", () => {
  assert.match(html, /styles\.css\?v=20260908fresh/);
  assert.match(html, /app\.mjs\?v=20260908fresh/);
  assert.match(app, /round-utils\.mjs\?v=20260908fresh/);
  assert.match(wrapper, /\/games\/saf-treevia\/v1\/.*20260908fresh/);
});
