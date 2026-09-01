#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENVELOPE_FORMAT = "saf-treevia-encrypted-v1";
export const PAYLOAD_SCHEMA_VERSION = 1;
export const DEFAULT_ITERATIONS = 310_000;
export const AAD = "saf-treevia.cochetopa.co/v1";

const SHORT_ANSWER_TYPES = new Set([
  "short_answer",
  "definition_prompt",
  "fill_in_blank",
]);

const MULTIPLE_CHOICE_TYPES = new Set([
  "multiple_choice",
  "true_false",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.%+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCsv(csvText) {
  const text = String(csvText ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV ended inside a quoted field.");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows.shift().map(clean);
  return rows
    .filter((values) => values.some((value) => clean(value)))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function tierCode(value) {
  const tier = clean(value).toUpperCase();
  if (tier.startsWith("A")) return "A";
  if (tier.startsWith("B")) return "B";
  if (tier.startsWith("C")) return "C";
  if (tier.startsWith("O")) return "Other";
  return null;
}

function parseChoiceParts(rawChoices, questionType) {
  let parts = clean(rawChoices)
    .split(/\s*\|\s*/)
    .map(clean)
    .filter(Boolean);

  if (!parts.length && questionType === "true_false") {
    parts = ["A. True", "B. False"];
  }
  if (parts.length < 2 || parts.length > 6) return null;

  const choices = [];
  const labels = new Set();
  const texts = new Set();
  for (const part of parts) {
    const match = part.match(/^([A-F1-6])\s*[.):\-]\s*(.+)$/i);
    if (!match) return null;
    const label = match[1].toUpperCase();
    const text = clean(match[2]);
    const normalizedText = normalize(text);
    if (!text || labels.has(label) || texts.has(normalizedText)) return null;
    labels.add(label);
    texts.add(normalizedText);
    choices.push({ label, text });
  }
  return choices;
}

function resolveCorrectChoice(answer, choices) {
  const rawAnswer = clean(answer);
  const normalizedAnswer = normalize(rawAnswer);
  // Prefer a unique option-text match. Some legitimate forestry answers are
  // themselves a single letter/number (for example, the A soil horizon), so
  // treating every `A` or `1` as an option label first can silently mis-key it.
  const exactTextMatches = choices
    .map((choice, index) => ({ index, normalized: normalize(choice.text) }))
    .filter((choice) => choice.normalized === normalizedAnswer);
  if (exactTextMatches.length === 1) return exactTextMatches[0].index;

  const labelOnly = rawAnswer.match(/^\s*([A-F1-6])\s*[.):\-]?\s*$/i);
  if (labelOnly) {
    return choices.findIndex((choice) => choice.label === labelOnly[1].toUpperCase());
  }

  const labeledAnswer = rawAnswer.match(/^\s*(?:answer\s*[:\-]?\s*)?([A-F1-6])\s*[.):\-]\s+/i);
  if (labeledAnswer) {
    const index = choices.findIndex((choice) => choice.label === labeledAnswer[1].toUpperCase());
    if (index >= 0) return index;
  }

  const firstClause = normalize(rawAnswer.split(/[;\n]/, 1)[0]);
  const firstClauseMatches = choices
    .map((choice, index) => ({ index, normalized: normalize(choice.text) }))
    .filter((choice) => choice.normalized === firstClause);
  if (firstClauseMatches.length === 1) return firstClauseMatches[0].index;

  const embeddedLabel = rawAnswer.match(/\b(?:correct\s+)?answer\s*(?:is|:)?\s*([A-F1-6])\b/i);
  if (embeddedLabel) {
    return choices.findIndex((choice) => choice.label === embeddedLabel[1].toUpperCase());
  }
  return -1;
}

function isWashingtonLocal(row) {
  const haystack = [
    row.Question,
    row.Notes,
    row.Source_File,
    row.Source_Organization,
    row.Source_Locator,
  ].map(clean).join(" ");
  return /\b(?:washington(?: state)?|tacoma|point defiance)\b/i.test(haystack);
}

function safeSourceUrl(value) {
  const sourceUrl = clean(value);
  return /^https?:\/\//i.test(sourceUrl) ? sourceUrl : "";
}

function sourceForRow(row) {
  return {
    title: clean(row.Source_Organization) || clean(row.Source_File) || "Source listed in master bank",
    year: clean(row.Source_Year),
    locator: clean(row.Source_Locator),
    url: safeSourceUrl(row.Source_URL),
  };
}

function buildQuestion(row, seenPrompts, skipped) {
  const id = clean(row.Question_ID);
  const tier = tierCode(row.Tier);
  const category = clean(row.Category) || "Uncategorized";
  const prompt = clean(row.Question);
  const answer = clean(row.Answer);
  const questionType = clean(row.Question_Type).toLowerCase();

  if (!id || !tier || !prompt || !answer) {
    skipped.missingRequired += 1;
    return null;
  }
  if (clean(row.Duplicate_Of)) {
    skipped.declaredDuplicate += 1;
    return null;
  }

  const normalizedPrompt = normalize(prompt);
  if (seenPrompts.has(normalizedPrompt)) {
    skipped.duplicatePrompt += 1;
    return null;
  }

  const base = {
    id,
    tier,
    category,
    prompt,
    answer,
    localContext: isWashingtonLocal(row),
    reviewFlag: clean(row.Review_Flag),
    source: sourceForRow(row),
  };

  if (MULTIPLE_CHOICE_TYPES.has(questionType)) {
    const parsedChoices = parseChoiceParts(row.Choices, questionType);
    if (!parsedChoices) {
      skipped.invalidChoices += 1;
      return null;
    }
    const correctChoiceIndex = resolveCorrectChoice(answer, parsedChoices);
    if (correctChoiceIndex < 0) {
      skipped.unmappedChoiceAnswer += 1;
      return null;
    }
    seenPrompts.add(normalizedPrompt);
    return {
      ...base,
      answer: parsedChoices[correctChoiceIndex].text,
      format: "multiple_choice",
      choices: parsedChoices.map((choice) => choice.text),
      correctChoiceIndex,
    };
  }

  if (SHORT_ANSWER_TYPES.has(questionType)) {
    seenPrompts.add(normalizedPrompt);
    return { ...base, format: "short_answer" };
  }

  skipped.unsupportedType += 1;
  return null;
}

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

export function validatePayload(payload) {
  if (!payload || payload.schemaVersion !== PAYLOAD_SCHEMA_VERSION) {
    throw new Error(`Unsupported payload schema. Expected ${PAYLOAD_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
    throw new Error("Payload must include at least one question.");
  }
  if (payload.questionCount !== payload.questions.length) {
    throw new Error("Payload questionCount does not match questions length.");
  }

  const ids = new Set();
  for (const question of payload.questions) {
    if (!question.id || ids.has(question.id)) throw new Error(`Duplicate or missing question id: ${question.id}`);
    ids.add(question.id);
    if (!["A", "B", "C", "Other"].includes(question.tier)) throw new Error(`Invalid tier on ${question.id}`);
    if (!question.prompt || !question.answer || !question.category) throw new Error(`Incomplete question ${question.id}`);
    if (question.format === "multiple_choice") {
      if (!Array.isArray(question.choices) || question.choices.length < 2) throw new Error(`Invalid choices on ${question.id}`);
      if (!Number.isInteger(question.correctChoiceIndex) || question.correctChoiceIndex < 0 || question.correctChoiceIndex >= question.choices.length) {
        throw new Error(`Invalid correct choice on ${question.id}`);
      }
    } else if (question.format !== "short_answer") {
      throw new Error(`Invalid format on ${question.id}`);
    }
  }
  return payload;
}

export function buildPayloadFromCsvText(csvText, { generatedAt = new Date().toISOString() } = {}) {
  const rows = parseCsv(csvText);
  const requiredHeaders = ["Question_ID", "Tier", "Category", "Question", "Answer", "Question_Type"];
  const availableHeaders = new Set(Object.keys(rows[0] ?? {}));
  for (const header of requiredHeaders) {
    if (!availableHeaders.has(header)) throw new Error(`CSV is missing required column: ${header}`);
  }

  const skipped = {
    missingRequired: 0,
    declaredDuplicate: 0,
    duplicatePrompt: 0,
    invalidChoices: 0,
    unmappedChoiceAnswer: 0,
    unsupportedType: 0,
  };
  const seenPrompts = new Set();
  const questions = rows
    .map((row) => buildQuestion(row, seenPrompts, skipped))
    .filter(Boolean);

  const counts = {
    total: questions.length,
    localContext: 0,
    tiers: {},
    formats: {},
    categories: {},
  };
  for (const question of questions) {
    increment(counts.tiers, question.tier);
    increment(counts.formats, question.format);
    increment(counts.categories, question.category);
    if (question.localContext) counts.localContext += 1;
  }

  return validatePayload({
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    generatedAt,
    questionCount: questions.length,
    counts,
    skipped,
    questions,
  });
}

export function createEncryptedEnvelope(payload, password, { iterations = DEFAULT_ITERATIONS } = {}) {
  validatePayload(payload);
  const normalizedPassword = clean(password);
  if (normalizedPassword.length < 6) throw new Error("Password must contain at least 6 characters.");
  if (!Number.isInteger(iterations) || iterations < 100_000) throw new Error("PBKDF2 iterations must be at least 100,000.");

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(normalizedPassword, "utf8"), salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(AAD, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    format: ENVELOPE_FORMAT,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: salt.toString("base64"),
    },
    cipher: {
      name: "AES-GCM",
      iv: iv.toString("base64"),
      tagLength: 128,
      aad: AAD,
    },
    ciphertext: Buffer.concat([ciphertext, tag]).toString("base64"),
  };
}

/** Test/support helper. Production browsers decrypt with Web Crypto in app.mjs. */
export function decryptEncryptedEnvelope(envelope, password) {
  if (envelope?.format !== ENVELOPE_FORMAT) throw new Error("Unsupported encrypted envelope.");
  const combined = Buffer.from(envelope.ciphertext, "base64");
  const tagLengthBytes = envelope.cipher.tagLength / 8;
  const ciphertext = combined.subarray(0, -tagLengthBytes);
  const tag = combined.subarray(-tagLengthBytes);
  const key = pbkdf2Sync(
    Buffer.from(clean(password), "utf8"),
    Buffer.from(envelope.kdf.salt, "base64"),
    envelope.kdf.iterations,
    32,
    "sha256",
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.cipher.iv, "base64"),
    { authTagLength: tagLengthBytes },
  );
  decipher.setAAD(Buffer.from(envelope.cipher.aad, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return validatePayload(JSON.parse(plaintext));
}

export function buildEncryptedPayload({ inputPath, outputPath, password, iterations = DEFAULT_ITERATIONS }) {
  const csvText = readFileSync(inputPath, "utf8");
  const payload = buildPayloadFromCsvText(csvText);
  const envelope = createEncryptedEnvelope(payload, password, { iterations });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return { payload, envelope };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const inputPath = resolve(args.input ?? "All_Questions.csv");
  const outputPath = resolve(args.output ?? resolve(scriptDirectory, "v1", "questions.enc.json"));
  const passwordEnv = args["password-env"] ?? "TREEVIA_PASSWORD";
  const password = process.env[passwordEnv];
  const iterations = args.iterations ? Number.parseInt(args.iterations, 10) : DEFAULT_ITERATIONS;
  if (!password) throw new Error(`Set ${passwordEnv} in the environment before building the encrypted payload.`);

  const { payload } = buildEncryptedPayload({ inputPath, outputPath, password, iterations });
  process.stdout.write([
    `Wrote encrypted SAF Tree'via payload: ${outputPath}`,
    `Playable questions: ${payload.questionCount}`,
    `Washington/Tacoma questions: ${payload.counts.localContext}`,
    `Skipped rows: ${Object.values(payload.skipped).reduce((sum, value) => sum + value, 0)}`,
  ].join("\n") + "\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Payload build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
