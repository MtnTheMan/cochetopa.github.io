# SAF Tree’via game

Static, dependency-free Quiz Bowl practice for `cochetopa.co`. The browser receives only an AES-GCM encrypted question payload until a student enters the shared team password. The password is never stored in source code or in the encrypted envelope.

## Files

- `build-payload.mjs` — imports the canonical master CSV, validates playable questions, and writes the encrypted browser payload.
- `v1/index.html` — password gate and game views.
- `v1/styles.css` — responsive MSU/forest visual system.
- `v1/app.mjs` — Web Crypto unlock, round setup, shuffling, immediate feedback, scoring, and retry flow.
- `v1/answer-utils.mjs` — conservative short-answer grading (`correct`, `close`, or `incorrect`).
- `v1/questions.enc.json` — generated encrypted bank. This is safe to publish but should never be replaced with plaintext.
- `v1/tests/` — Node tests for answer grading, CSV import, MC answer mapping, and encryption round-trips.

## Build the encrypted bank

Use Node 20 or newer. Set the password only in the process environment; do not add it to a script, README, `.env` file, HTML, or commit.

```powershell
$env:TREEVIA_PASSWORD = Read-Host "Tree'via team password"
node games/saf-treevia/build-payload.mjs `
  --input "C:\path\to\All_Questions.csv" `
  --output "games\saf-treevia\v1\questions.enc.json"
Remove-Item Env:TREEVIA_PASSWORD
```

The builder uses PBKDF2-HMAC-SHA-256 (310,000 iterations) and AES-256-GCM with fresh random salt and IV values on every build. It writes no plaintext intermediate file.

## Import rules and payload contract

The canonical CSV must include `Question_ID`, `Tier`, `Category`, `Question`, `Answer`, and `Question_Type`. The site imports:

- `multiple_choice` and `true_false` when choices parse cleanly and the answer maps to exactly one choice;
- `short_answer`, `definition_prompt`, and `fill_in_blank` as free response;
- no rows with `Duplicate_Of` populated; and
- no duplicate normalized prompts.

Field, specimen, matching, and site-assessment activities are intentionally omitted because their media or multi-part interaction is not represented in the browser game.

The encrypted plaintext schema is:

```text
schemaVersion, generatedAt, questionCount, counts, skipped,
questions[]: id, tier, category, prompt, answer, localContext, quizletPdf,
             reviewFlag, source, format,
             choices + correctChoiceIndex (MC only)
```

`localContext` is set when question/source metadata mentions Washington, Tacoma, or Point Defiance. The UI combines that flag with tier A for the “Washington + Tacoma 2026” set, keeping the host-region round source-checked.

The setup selector defaults to A tier and is ordered A tier, Washington + Tacoma, Quizlet cards: mixed, Quizlet cards: hard mode (all short answer), B tier, C tier, then Other. Both Quizlet options select the same 238 unique attached PDF cards using the payload's source-derived `quizletPdf` flag; those questions also remain in A tier. The mixed set contains 166 multiple-choice and 72 short-answer questions. Distractors are newly authored practice options, not historical PDF choices. Lists, calculations, core recall, and stems without clean distractors remain short answer.

Hard mode presents all 238 original prompts and answer keys as short answer, removing choices only from the in-memory practice copies. It locks the response mode to short answer without filtering out cards that were multiple choice in the mixed set. Categories and round length still apply. Selecting the mixed set restores mixed response mode. For every new round, the game shuffles the full eligible question pool before applying the requested round length; it never takes the first rows from the workbook. Multiple-choice options are shuffled separately. The retry action then reshuffles only the questions marked missed or close, retaining their practice format.

The September 3, 2026 bank includes all 243 cards from the user's three attached Quizlet PDFs as 238 unique A-tier questions (five duplicates resolve to those questions). This is user-designated tier placement, not a claim that every card is official SAF or independently fact-checked. PDF title and page/card locator appear with each answer; review cautions are displayed after grading. Online-only catalog decks remain separate.

## Short-answer grading

The client deliberately favors false negatives over false positives:

- exact answers, explicit aliases, simple unit equivalents, and one-character typos can be `correct`;
- partial key-phrase coverage can be `close` and earns half credit;
- numeric mismatches and negation mismatches are `incorrect`;
- explicit list keys such as `Any two: a; b; c` require the requested number of complete components for `correct`; one valid component is `close`; and
- every response immediately reveals the canonical answer, so students can review ambiguous wording.

## Test

From the repository root:

```powershell
node --test games/saf-treevia/v1/tests/run.mjs
node --check games/saf-treevia/v1/app.mjs
node --check games/saf-treevia/build-payload.mjs
```

For local manual use, serve the repository over HTTP; browser `fetch()` will not load the bank from a `file://` URL.

## Security boundary

This is a password-gated static site, not an identity system. Encryption keeps the questions and password out of readable page source and deters casual access, but anyone who downloads the encrypted payload can attempt guesses offline. A weak shared password cannot provide the same protection as server-side authentication. True access control would require a server/edge authorization layer.
