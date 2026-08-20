# New OMS UI Phases 2–5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the New OMS shipment queues, shipment detail, activity drawer, held/failure evidence, existing safe read-only actions, and quality pass without changing Classic UI or backend behavior.

**Architecture:** `OmsWorkspace` remains the New OMS composition and navigation boundary. A new `useOmsWorkspaceData` hook owns bounded, manually driven queue/detail requests with request-generation guards, while small focused components render tabs, filters, rows, summary, journey, evidence, and the modal activity drawer. All data comes from the existing `dryRunApi.js` and `shipmentActivityApi.js` exports.

**Tech Stack:** React 18, React Router 6, plain CSS, Jest 29, React Testing Library, Vite 5

**Spec:** `docs/superpowers/specs/2026-08-19-new-oms-extension-ui-design.md`

## Global Constraints

- Do not edit `frontend/pages/Home.jsx`, any file under `frontend/components/dry-run/`, any file under `frontend/components/activity/`, either frontend service, or any backend file.
- Do not add dependencies or new API routes.
- New OMS must never use `setInterval`, schedule delayed refresh work with `setTimeout`, or subscribe to `visibilitychange`.
- New OMS fetches only the active queue, with list page size `20` and timeline page size `50`.
- Refresh and Load more are the only list re-fetch triggers after a queue has loaded; selecting a row and detail Refresh are the only detail triggers.
- A successful queue refresh replaces that queue's first page. A failed refresh retains verified rows and the current usable cursor.
- A successful detail refresh replaces the selected timeline and optional journey. A failed refresh retains verified detail evidence.
- `401` is terminal for the current New OMS mount. `404` for a timeline produces “Shipment evidence unavailable” without removing the list row.
- Failures contains two labelled groups with independent cursors: job failures and pre-job rejections. Never merge their cursor streams.
- Expose no Retry, Reprocess, Unlock, Approve, Submit, Import, Reconcile, or invoice-transition action.
- Pod cURL eligibility must remain exactly: dry-run mode, `SUBMISSION_HELD`, completed Fynd lock, `locked === true`, and held OEIS submission.
- Never render raw Axios errors, server payloads, API keys, copied commands, or non-allowlisted customer fields.
- Prefix every new selector with `oms-` or `extension-experience-`; keep the existing global styles unchanged.
- Keep every implementation change uncommitted and unstaged for review. The earlier design-document commit is not an implementation commit.
- The user has approved continuous implementation of Phases 2–5, superseding the old pause after every phase; keep technical checkpoints but do not stop between phases.

## Visual System

- Palette: canvas `#f5f4f7`, surface `#ffffff`, ink `#241d2d`, muted `#6e6875`, border `#e3e0e7`, platform purple `#5b2a86`; semantic chip colours derive from these with restrained green/amber/red/blue backgrounds.
- Type: Inter/system sans-serif for interface content and `ui-monospace, SFMono-Regular, Menlo, monospace` for shipment IDs, document numbers, hashes, and technical values.
- Layout: a compact operator ledger, not a card-metric dashboard.

```text
Queue view                                  Detail view
┌ title/context ───────── Refresh ───────┐  ┌ Back ─ shipment/document ─ Refresh ┐
├ Shipments | Held | Failures ──────────┤  ├ status summary ────────────────────┤
├ search loaded | stage | outcome ──────┤  ├ Fynd → OEIS → artifact → Fynd rail ┤
├ dense shipment rows / mobile cards ───┤  ├ overview + collapsed evidence ─────┤
└ loaded count ───────────── Load more ─┘  └ activity trigger → right drawer ───┘
```

- Signature: the lifecycle rail encodes actual shipment processing order. It is the single memorable visual element; filters, rows, and evidence surfaces remain quiet and precise.
- Design self-critique: metric cards, decorative gradients, invented commerce columns, and ambient motion would make this a generic dashboard. They are excluded. The rail, queue density, and exact operational copy are specific to this extension.

## File Map

- Create `frontend/components/oms/omsModel.js`: labels, formatting, row normalization, filtering, deduplication, safe snapshot projection, and pod-cURL pure helpers.
- Create `frontend/components/oms/useOmsWorkspaceData.js`: bounded queue/detail state, request guards, manual refresh, pagination, terminal session state, downloads, and copy action orchestration.
- Create `frontend/components/oms/OmsHeader.jsx`: view context, Refresh, busy state, live feedback, and successful refresh time.
- Create `frontend/components/oms/ShipmentQueueTabs.jsx`: roving-tabindex keyboard tabs and loaded counts.
- Create `frontend/components/oms/ShipmentFilters.jsx`: search/stage/outcome controls limited to loaded rows.
- Create `frontend/components/oms/ShipmentStatusChip.jsx`: centralized text-plus-colour outcome rendering.
- Create `frontend/components/oms/ShipmentTable.jsx`: accessible row controls, desktop columns, and mobile cards.
- Create `frontend/components/oms/OmsStateView.jsx`: loading, empty, warning, error, unavailable, and unauthorized states.
- Create `frontend/components/oms/ShipmentDetail.jsx`: detail composition, back navigation, refresh, and activity trigger.
- Create `frontend/components/oms/ShipmentSummary.jsx`: current identity and operational evidence summary.
- Create `frontend/components/oms/ShipmentJourney.jsx`: lifecycle rail derived only from returned evidence.
- Create `frontend/components/oms/ShipmentEvidence.jsx`: allowlisted safe summaries and collapsed diagnostic panels.
- Create `frontend/components/oms/ShipmentActivityDrawer.jsx`: accessible modal drawer, chronological activity, and older pagination.
- Modify `frontend/components/oms/OmsWorkspace.jsx`: replace the Phase 1 placeholder with queue/detail composition.
- Modify `frontend/components/oms/oms.css`: add the dense list/detail/drawer responsive system.
- Create `frontend/test/components/oms/omsFixtures.js`: complete test-only service fixtures.
- Create focused tests beside the existing OMS tests for the model, queue tabs/table, workspace data lifecycle, detail/evidence/actions, and drawer focus.

---

### Task 1: Pure OMS display model and presentational primitives

**Files:**
- Create: `frontend/components/oms/omsModel.js`
- Create: `frontend/components/oms/ShipmentStatusChip.jsx`
- Create: `frontend/components/oms/OmsStateView.jsx`
- Create: `frontend/test/components/oms/omsModel.spec.js`
- Create: `frontend/test/components/oms/ShipmentStatusChip.spec.js`

**Interfaces:**
- Produces: `QUEUE_IDS`, `queueLabel`, `stageLabel`, `actionLabel`, `outcomeLabel`, `statusTone`, `formatUtc`, `formatDuration`, `normalizeShipmentRow`, `normalizeHeldRow`, `normalizeJobFailureRow`, `normalizePreJobFailureRow`, `filterLoadedRows`, `appendUniqueRows`, `eventIdentity`, `projectDiagnosticSnapshot`, `canCopyPodCurl`, and `buildPodCurl`.

- [x] **Step 1: Write failing model tests**

Cover literal normalization for all four row sources; text labels for every known stage/action/outcome; invalid timestamps as `Time unavailable`; loaded-only case-insensitive search across shipment/document/safe code; exact stage/outcome filters; stable deduplication; safe diagnostic snapshot allowlisting; exact pod-cURL eligibility; and POSIX quoting of apostrophes, `$()`, backticks, and newlines without rendering the command.

- [x] **Step 2: Run the model tests and verify RED**

Run `cd frontend && npm test -- --runInBand test/components/oms/omsModel.spec.js`.

Expected: module-not-found failure because `omsModel.js` does not exist.

- [x] **Step 3: Implement the minimal pure model**

Use immutable literal label maps copied from the trusted Classic labels. Normalized rows use this shape:

```js
{
  key, source, shipmentId, jobId, documentNumber,
  stage, action, outcome, safeCode, updatedAt,
  failureMessage, attemptCount, raw
}
```

`normalizePreJobFailureRow` keeps `jobId` and `documentNumber` null. `appendUniqueRows` preserves accepted server order. `projectDiagnosticSnapshot` copies only the allowlist already used by Classic `JourneyDetail`. `buildPodCurl` returns the exact direct `curl --data-binary` layout and never writes it to the DOM.

- [x] **Step 4: Run the model tests and verify GREEN**

Run the Step 2 command. Expected: all model cases pass.

- [x] **Step 5: Add failing status/state component tests**

Assert text and tone classes for success, failure, timeout, held, retry-scheduled, started, and indeterminate; assert warning uses `role="status"`, unauthorized uses `role="alert"`, and the loader uses a polite atomic live region.

- [x] **Step 6: Implement and verify the status/state components**

`ShipmentStatusChip` renders returned status text as well as colour. `OmsStateView` accepts `{ kind, title, message }` and renders no operational control of its own. Run both focused suites and keep them green.

---

### Task 2: Phase 2 Shipments queue and manual list lifecycle

**Files:**
- Create: `frontend/components/oms/useOmsWorkspaceData.js`
- Create: `frontend/components/oms/OmsHeader.jsx`
- Create: `frontend/components/oms/ShipmentQueueTabs.jsx`
- Create: `frontend/components/oms/ShipmentFilters.jsx`
- Create: `frontend/components/oms/ShipmentTable.jsx`
- Modify: `frontend/components/oms/OmsWorkspace.jsx`
- Modify: `frontend/components/oms/oms.css`
- Create: `frontend/test/components/oms/omsFixtures.js`
- Create: `frontend/test/components/oms/OmsWorkspaceShipments.spec.js`
- Create: `frontend/test/components/oms/ShipmentQueueTabs.spec.js`
- Create: `frontend/test/components/oms/ShipmentTable.spec.js`

**Interfaces:**
- Consumes: `listShipmentActivity({ companyId, limit: 20, before })`.
- Produces: `useOmsWorkspaceData({ companyId })` returning `activeQueue`, `queueView`, `detailView`, `terminal`, `feedback`, and action callbacks used by `OmsWorkspace`.

- [x] **Step 1: Write failing initial-load tests**

Render the real `OmsWorkspace` inside `/company/:company_id/application/:application_id`. Assert exactly one call with `{ companyId, limit: 20, before: null }`, no dry-run/failure/timeline calls, a bounded loading state, returned rows and loaded count, optional-field fallbacks, and no timer or visibility listener.

- [x] **Step 2: Run and verify RED**

Run `cd frontend && npm test -- --runInBand test/components/oms/OmsWorkspaceShipments.spec.js`.

Expected: failures because Phase 1 has no list request or queue UI.

- [x] **Step 3: Implement initial queue state and Shipments view**

The hook starts Shipments once on mount. Each request carries a monotonically increasing generation and checks `mountedRef`, terminal state, active queue, and generation before writing. `OmsWorkspace` renders `OmsHeader`, the three tabs, filter toolbar, labelled tabpanel, and `ShipmentTable`.

- [x] **Step 4: Write failing Refresh and Load-more tests**

Assert Refresh uses `before: null`, is disabled and labelled `Refreshing…` while pending, replaces rows/cursor on success, sets Last refreshed only after success, retains rows/cursor on transient failure, and ignores a double click. Assert Load more sends the exact opaque cursor, appends/deduplicates in server order, retains the cursor after failure for retry, and stops when cursor is null. With deferred requests, assert switching away invalidates pending success and `401`, switching back starts cleanly, and placeholder queues cannot trigger a Shipments refresh.

- [x] **Step 5: Implement Refresh and pagination, then verify GREEN**

Use no scheduled work. Refresh feedback is a polite live region. If no verified rows exist, request failure renders an error state; otherwise it renders a non-destructive warning above retained rows.

- [x] **Step 6: Write failing filter and table tests**

Assert search/stage/outcome affect only loaded rows and never call services; copy says `Showing X of Y loaded`; reset restores loaded rows. Assert each row is a native button with an accessible name containing shipment and status, identifiers expose a `title`, and missing document/safe code render honest fallbacks.

- [x] **Step 7: Implement filtering/table and keyboard tabs**

Tabs use `role="tablist"`, `role="tab"`, `aria-selected`, associated `tabpanel`, and roving `tabIndex`. Arrow Left/Right, Home, and End move focus and activate the corresponding queue. Do not prefetch inactive queues.

- [x] **Step 8: Add the Phase 2 responsive styling and verify**

Desktop uses a compact table grid; at `720px` and below it becomes stacked row cards without changing source order. Add visible focus, 44px practical targets, identifier wrapping, and reduced-motion rules. Run all Task 2 suites plus existing OMS tests.

---

### Task 3: Phase 3 detail lifecycle, summary, journey, and evidence

**Files:**
- Modify: `frontend/components/oms/useOmsWorkspaceData.js`
- Create: `frontend/components/oms/ShipmentDetail.jsx`
- Create: `frontend/components/oms/ShipmentSummary.jsx`
- Create: `frontend/components/oms/ShipmentJourney.jsx`
- Create: `frontend/components/oms/ShipmentEvidence.jsx`
- Modify: `frontend/components/oms/OmsWorkspace.jsx`
- Modify: `frontend/components/oms/oms.css`
- Create: `frontend/test/components/oms/OmsShipmentDetail.spec.js`
- Create: `frontend/test/components/oms/ShipmentEvidence.spec.js`

**Interfaces:**
- Consumes: `getShipmentTimeline({ companyId, shipmentId, limit: 50, before: null })` and, only when `jobId` is non-null, `getDryRunJourney({ companyId, jobId })` in parallel.
- Produces: detail state containing the selected normalized row, timeline page, optional dry-run journey, independent error/warning states, and a successful detail refresh time.

- [x] **Step 1: Write failing selection and back-navigation tests**

Assert row activation hides the table, immediately clears prior detail, requests timeline plus optional journey once, renders Overview/Journey/Evidence, and Back restores the already loaded queue without another list request. A row with `jobId: null` must not call `getDryRunJourney`.

- [x] **Step 2: Run and verify RED**

Run `cd frontend && npm test -- --runInBand test/components/oms/OmsShipmentDetail.spec.js`.

Expected: no detail view exists.

- [x] **Step 3: Implement guarded detail loading**

Selection increments a detail generation, stores the row, clears old evidence, and starts the permitted requests in parallel. Every completion checks mounted state, terminal state, active queue, selected row key, and generation. Timeline `404` renders `Shipment evidence unavailable`; journey `404` renders a journey-specific unavailable note while keeping timeline evidence.

- [x] **Step 4: Write failing stale/Refresh/error tests**

Cover stale success and stale `401` after a second selection, detail Refresh without list refresh, successful detail timestamp, retention of verified evidence after a transient failure, current-selection terminal `401`, and row retention after timeline `404`.

- [x] **Step 5: Implement detail Refresh and error handling**

Refresh only the visible detail. It replaces successful first pages, retains verified evidence on retryable failure, and never overlaps another detail refresh. Current `401` clears the visible protected detail and places the New OMS mount in its terminal alert state.

- [x] **Step 6: Write failing presentation/evidence tests**

Assert the summary uses returned shipment/document/job/latest update/safe code; the rail orders Webhook → Fynd lock → OEIS → Artifact → Fynd transition and labels missing stages `Not reached`; automatic retry shows attempt, delay, next-attempt time, and safe code; safe summaries render only their fixed allowlisted fields; normalized JSON is collapsed and excludes hostile/customer fields.

- [x] **Step 7: Implement summary, rail, and collapsed evidence**

Do not invent completed stages. Select the latest returned event for each rail stage. Use native `<details>` disclosures for normalized and technical evidence. Render values through explicit fields rather than generic object traversal except the already projected diagnostic snapshot JSON.

- [x] **Step 8: Verify Task 3 focused suites**

Run Task 3 tests plus the Task 2 workspace suite. Expected: queue data is preserved while navigating list → detail → list.

---

### Task 4: Phase 3 accessible activity drawer and timeline pagination

**Files:**
- Create: `frontend/components/oms/ShipmentActivityDrawer.jsx`
- Modify: `frontend/components/oms/ShipmentDetail.jsx`
- Modify: `frontend/components/oms/useOmsWorkspaceData.js`
- Modify: `frontend/components/oms/oms.css`
- Create: `frontend/test/components/oms/ShipmentActivityDrawer.spec.js`

**Interfaces:**
- Consumes: current timeline items/cursor and `loadOlderActivity()`.
- Produces: modal `role="dialog"` drawer with a labelled chronology and focus lifecycle.

- [x] **Step 1: Write failing focus/dialog tests**

Assert the trigger opens an accessible modal drawer, initial focus moves to Close, Tab and Shift+Tab wrap inside the drawer, Escape closes it, and focus returns to the same trigger. Assert background content is marked inert/hidden to assistive technology while open where supported by React/DOM semantics.

- [x] **Step 2: Run and verify RED**

Run `cd frontend && npm test -- --runInBand test/components/oms/ShipmentActivityDrawer.spec.js`.

- [x] **Step 3: Implement the drawer without global scheduled work**

Use a dialog-local `onKeyDown` trap and mount/unmount focus effect; do not install a visibility listener or timer. The desktop drawer is fixed to the right; at narrow width it uses the full viewport.

- [x] **Step 4: Write failing older-activity tests**

Assert Load older sends the exact current cursor, prepends older events while preserving chronological order, deduplicates overlaps, retains evidence/cursor after failure, and has no control when the cursor is null.

- [x] **Step 5: Implement older pagination and verify GREEN**

Use `eventIdentity` for overlap removal. Keep a drawer-local non-destructive warning after a failed older-page request so the same cursor can be attempted again.

---

### Task 5: Phase 4 Held and Failures queues

**Files:**
- Modify: `frontend/components/oms/useOmsWorkspaceData.js`
- Modify: `frontend/components/oms/ShipmentTable.jsx`
- Modify: `frontend/components/oms/OmsWorkspace.jsx`
- Modify: `frontend/components/oms/oms.css`
- Create: `frontend/components/oms/FailureQueue.jsx`
- Create: `frontend/test/components/oms/OmsHeldQueue.spec.js`
- Create: `frontend/test/components/oms/OmsFailureQueue.spec.js`

**Interfaces:**
- Held consumes `listDryRuns({ companyId, limit: 20, beforeId })`.
- Failures consumes both `listDryRunFailures({ companyId, limit: 20, beforeId })` and `listPreJobFailures({ companyId, limit: 20, before })`.

- [x] **Step 1: Write failing Held tests**

Assert selecting Held fetches its first page only once, normalizes held rows without fetching failures, supports numeric-cursor pagination and manual replacement Refresh, and opens the same detail experience with its job/timeline/journey identity.

- [x] **Step 2: Implement Held and verify GREEN**

Switching queues invalidates pending writes from the previous queue. Previously loaded queues remain cached for this OMS mount; returning to one does not refetch until Refresh.

- [x] **Step 3: Write failing Failures tests**

Assert first activation calls the two failure services in parallel and no unrelated service. Render `Job failures` and `Rejected before a job was created` as separate labelled groups, suppress a pre-job row when a job failure for the same shipment exists, show safe message/attempt evidence, and keep separate loaded counts/cursors.

- [x] **Step 4: Implement Failures with independent pagination**

Each subgroup has its own Load more control and busy/error state. A failure in one request must not discard successful rows from the other. Current `401` from either active request is terminal. No single combined cursor or globally sorted claim is shown.

- [x] **Step 5: Cover inactive-queue, stale, and retention behavior**

Add tests for no prefetch, delayed response ignored after tab change, cached queue return, failed Refresh retaining each verified subgroup, cursor retry after Load more failure, and no manual Retry control anywhere.

- [x] **Step 6: Verify all queue suites**

Run all OMS queue tests and service-call assertions. Confirm initial New OMS still performs only one Shipments request.

---

### Task 6: Phase 4 diagnostic download and eligible pod cURL copy

**Files:**
- Modify: `frontend/components/oms/useOmsWorkspaceData.js`
- Modify: `frontend/components/oms/ShipmentEvidence.jsx`
- Modify: `frontend/components/oms/oms.css`
- Create: `frontend/test/components/oms/OmsEvidenceActions.spec.js`

**Interfaces:**
- Consumes: `getDryRunRequestBlob({ companyId, jobId })` and `getDryRunPodCurl({ companyId, jobId })`.
- Uses: `canCopyPodCurl(detail)` and `buildPodCurl(envelope)` from `omsModel.js`.

- [x] **Step 1: Write failing action eligibility tests**

Assert Download appears only with a loaded dry-run journey/body filename. Assert Copy pod cURL appears only for every exact eligibility condition and is absent when any one condition changes. Assert Retry and every forbidden mutating action remain absent.

- [x] **Step 2: Implement action presentation and safety copy**

The Copy control is preceded by the prominent real-submission and duplicate-invoice warning. The command and API key never appear in DOM text, attributes, errors, or feedback.

- [x] **Step 3: Write failing download tests**

Cover authenticated Blob retrieval, exact filename, object URL creation/click/revocation, selection-change and unmount stale guards, `401` terminal handling, and fixed sanitized failure feedback.

- [x] **Step 4: Implement download lifecycle and verify**

Revoke object URLs in immediate failure paths and unmount cleanup. A short revocation timeout is permitted only for object-URL cleanup, never for refresh/data loading; register and clear it explicitly.

- [x] **Step 5: Write failing copy tests**

Cover a fresh envelope on every click, exact POSIX-safe command copied through Clipboard API, duplicate click suppression, selection/route/unmount stale guards, missing/rejecting Clipboard behavior, `404` journey unavailability, and current `401` terminal state.

- [x] **Step 6: Implement copy orchestration and verify GREEN**

Keep envelope/command variables local and null them in `finally`. Do not use an `execCommand` or DOM fallback. Feedback is only `Pod cURL copied` or `Pod cURL could not be copied`.

---

### Task 7: Phase 5 integrated accessibility, responsive, and regression pass

**Files:**
- Modify as required only within `frontend/components/oms/`, `frontend/test/components/oms/`, and the two Phase 1 integration files.
- Modify: `docs/superpowers/plans/2026-08-19-new-oms-ui-phases-2-5.md` checkbox state only.

**Interfaces:**
- Produces: complete approved New OMS experience with unchanged Classic behavior.

- [x] **Step 1: Add the cross-phase quality tests**

Cover route change remount, switch cleanup, no timers/background refresh/visibility listeners, no requests after New OMS unmount, stale response suppression, terminal session lockout, polite live regions, alert semantics, keyboard rows/tabs/drawer, identifier full values, and absence of forbidden controls.

- [x] **Step 2: Run focused OMS verification**

Run `cd frontend && npm test -- --runInBand test/App.spec.js test/components/oms`.

Expected: every OMS and integration test passes.

- [x] **Step 3: Run affected Classic regression tests**

Run `cd frontend && npm test -- --runInBand test/pages/Home.spec.js test/components/dry-run/DryRunJourney.spec.js test/components/activity/ShipmentActivityLog.spec.js`.

Expected: Classic behavior remains unchanged except the already-approved hand-derived backend-contract mismatch in `DryRunJourney.spec.js`.

- [x] **Step 4: Run complete frontend verification and build**

Run `cd frontend && npm test -- --runInBand` and `cd frontend && npm run build`. Record exact pass/fail counts. Do not claim all-green if the approved pre-existing contract assertion remains.

- [x] **Step 5: Perform real-browser verification**

Verify Classic/New OMS switching, one active tree, Shipments/Held/Failures requests only on activation, manual Refresh/Load more, list → detail → back preservation, drawer focus/Escape/restore, no post-mount polling, wide/720px/narrow layout, reduced motion, and sanitized console/network behavior.

- [x] **Step 6: Run final static review**

Run `git diff --check`, `git status --short`, and a production-source search for timers, visibility listeners, forbidden actions, service/backend edits, and unprefixed selectors. Request an independent whole-diff code review and resolve all Critical/Important findings.

- [x] **Step 7: Present the uncommitted review state**

Do not stage or commit. Report files changed, verification evidence, the single approved baseline failure if it remains, and any explicit rulings made while implementing.
