import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayloadFromCsvText,
  createEncryptedEnvelope,
  decryptEncryptedEnvelope,
  ENVELOPE_FORMAT,
  parseCsv,
} from "../../build-payload.mjs";

const header = [
  "Question_ID",
  "Tier",
  "Category",
  "Question",
  "Answer",
  "Choices",
  "Question_Type",
  "Source_Organization",
  "Source_File",
  "Source_Locator",
  "Source_Year",
  "Source_URL",
  "Duplicate_Of",
  "Review_Flag",
  "Notes",
].join(",");

const rows = [
  "SAF-A-0001,A - Confirmed,Silviculture,Which treatment favors shade-intolerant regeneration?,Clearcut,A. Selection | B. Clearcut,multiple_choice,Extension,test.pdf,p. 1,2025,https://example.test/a,,,",
  "SAF-B-0001,B - Supplemental,Policy,What is the state tree of Washington?,Western hemlock,,short_answer,Washington Legislature,WEB/state-tree,RCW 1.20.020,2026,https://example.test/b,,,Tacoma local context",
  "SAF-C-0001,C - Practice,Policy,What is the state tree of Washington?,Western hemlock,,short_answer,Duplicate,test.pdf,p. 2,2020,https://example.test/c,SAF-B-0001,,",
  "SAF-A-0002,A - Confirmed,Ecology,Malformed choice item,B,A. One | A. Two,multiple_choice,Source,test.pdf,p. 3,2025,https://example.test/d,,,",
  "SAF-A-0003,A - Confirmed,Field,Identify this specimen,Douglas-fir,,specimen_identification,Source,test.pdf,p. 4,2025,https://example.test/e,,,",
  "SAF-A-0004,A - Confirmed,Soils,Which option is the A soil horizon?,A,A. O | B. A,multiple_choice,Source,test.pdf,p. 5,2025,https://example.test/f,,,",
  "SAF-A-0005,A - Confirmed,Biometrics,Which option is one?,1,A. 1 | B. 2,multiple_choice,Source,test.pdf,p. 6,2025,https://example.test/g,,,",
];

const fixtureCsv = `${header}\r\n${rows.join("\r\n")}\r\n`;

test("CSV parser supports quoted commas and line breaks", () => {
  const parsed = parseCsv('A,B\r\n"one, two","line 1\nline 2"\r\n');
  assert.deepEqual(parsed, [{ A: "one, two", B: "line 1\nline 2" }]);
});

test("builder emits only playable, unique questions with mapped MC answers", () => {
  const payload = buildPayloadFromCsvText(fixtureCsv, { generatedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(payload.questionCount, 4);
  assert.equal(payload.counts.localContext, 1);
  assert.deepEqual(payload.counts.tiers, { A: 3, B: 1 });
  assert.equal(payload.questions[0].format, "multiple_choice");
  assert.equal(payload.questions[0].correctChoiceIndex, 1);
  assert.deepEqual(payload.questions[0].choices, ["Selection", "Clearcut"]);
  assert.equal(payload.questions[0].answer, "Clearcut");
  assert.equal(payload.questions[1].localContext, true);
  assert.equal(payload.questions[2].correctChoiceIndex, 1);
  assert.equal(payload.questions[2].answer, "A");
  assert.equal(payload.questions[3].correctChoiceIndex, 0);
  assert.equal(payload.questions[3].answer, "1");
  assert.equal(payload.skipped.declaredDuplicate, 1);
  assert.equal(payload.skipped.invalidChoices, 1);
  assert.equal(payload.skipped.unsupportedType, 1);
});

test("AES-GCM envelope round-trips without exposing question plaintext", () => {
  const payload = buildPayloadFromCsvText(fixtureCsv, { generatedAt: "2026-09-01T00:00:00.000Z" });
  const password = "test-only-password";
  const envelope = createEncryptedEnvelope(payload, password, { iterations: 100_000 });
  assert.equal(envelope.format, ENVELOPE_FORMAT);
  assert.equal(envelope.kdf.name, "PBKDF2");
  assert.equal(envelope.cipher.name, "AES-GCM");
  assert.equal(JSON.stringify(envelope).includes("state tree of Washington"), false);
  assert.deepEqual(decryptEncryptedEnvelope(envelope, password), payload);
  assert.throws(() => decryptEncryptedEnvelope(envelope, "wrong-password"));
});
