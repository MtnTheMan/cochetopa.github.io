import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(testDir, "..", "index.html"), "utf8");
const app = fs.readFileSync(path.resolve(testDir, "..", "app.mjs"), "utf8");

test("question sets default to A tier and follow the requested sequence", () => {
  const select = html.match(/<select id="set-select"[\s\S]*?<\/select>/)?.[0] ?? "";
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ["A", "local", "B", "C", "Other"]);
  assert.match(select, /<option value="A" selected>/);
  assert.doesNotMatch(html, /id="custom-tier-fields"/);
});

test("every app DOM reference exists in the page", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const references = [...app.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(references.filter((id) => !ids.has(id)), []);
});
