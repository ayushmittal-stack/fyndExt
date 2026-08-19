# Real OEIS response import implementation plan

> **For Codex:** Execute this plan with test-driven development and stop before any live mutation unless every guard and focused/full regression is green.

**Goal:** Import one genuine OEIS response for an exact held shipment, retain response evidence, and complete the existing Fynd transition without a second OEIS submission.

**Architecture:** Extend the strict response parser to validate the real envelope and signed UBL against the exact request. Add a private response-attempt collection and one narrowly scoped atomic held-response import repository operation. Drive it from a one-shot operator script, then use the existing outbox workflow for Fynd.

**Tech stack:** Node.js 24, Jest, MongoDB transactions, Saxes XML parser, existing invoice repository/workflow.

---

### Task 1: Real response parser

**Files:** `src/einvoice/response-parser.js`, `test/einvoice/response-parser.spec.js`

1. Add a sanitized real-response fixture and failing tests for the exact live envelope, signed UBL/request reconciliation, distinct source/OEIS invoice identities, totals, tax, discount, payment, UUID, and malformed/conflicting variants.
2. Implement strict descriptor-safe parsing and canonical response evidence bytes/hash.
3. Run the focused parser suite.

### Task 2: Private response evidence and atomic held import

**Files:** `src/einvoice/repositories/mongo-indexes.js`, `src/einvoice/repositories/invoice-repository.js`, `src/einvoice/repositories/mongo-invoice-repository.js`, `test/einvoice/mongo-invoice-repository.outbox.spec.js`, `test/einvoice/mongo-invoice-repository.reads.spec.js`

1. Add failing repository tests for exact held-job CAS, only-two-field request correction, artifact/source identity binding, response evidence retention, duplicate OEIS identities, rollback, and public-read non-exposure.
2. Add `oeis_response_attempts` with exact unique and TTL indexes.
3. Implement `importHeldOeisResponseAndEnqueue` as one transaction; leave the ordinary submission mutation unchanged.
4. Run focused repository suites.

### Task 3: Operator import command

**Files:** `scripts/import-held-oeis-response.js`, `test/einvoice/import-held-oeis-response.spec.js`, `package.json`

1. Add failing tests for absolute response path, exact company/shipment/job/version/hash confirmation, no secret/body output, parser/repository errors, and dry preflight.
2. Implement a one-shot command that reads the response file, loads Mongo, validates and imports, then exits without calling OEIS.
3. Run focused command tests.

### Task 4: Regression verification

1. Run parser, repository, workflow, activity/privacy, and CLI suites.
2. Run the complete backend suite, syntax checks, and `git diff --check`.
3. Confirm no public response contains private evidence.

### Task 5: Exact live recovery

1. Read-only preflight exact job/version/hash/state, duplicate identities, current Fynd lock state, and response/request reconciliation.
2. Run the one-shot import once.
3. Claim and process the resulting outbox using the existing workflow.
4. Read-only verify job `COMPLETED`, outbox `COMPLETED`, artifact identities, response evidence hash, and Fynd invoiced/unlocked state.
