# New OMS Extension UI Design

**Date:** 2026-08-19  
**Status:** Approved for implementation
**Scope:** Frontend presentation and frontend data orchestration only

## Purpose

Add a Fynd OMS-inspired shipment operations experience to the e-invoicing extension without replacing or refactoring the current UI. Operators can switch between the current Classic UI and the New OMS UI, review a paginated shipment list, open shipment details, inspect the existing journey and activity evidence, and use only the read-only actions that already exist.

The work deliberately changes no backend route, processing rule, retry policy, lock behavior, OEIS behavior, invoice transition, or persistence model.

## Decisions Already Approved

- The current UI remains available as **Classic** and its React components are not edited.
- A header-level segmented switch selects **Classic** or **New OMS**.
- Only the selected experience is mounted. The two UIs never run together.
- Classic is the initial default for a company/application until the operator selects New OMS.
- The New OMS UI has no polling, interval, background refresh, or visibility-triggered refresh.
- New OMS data changes only after an explicit Refresh, Load more, tab change, or shipment selection.
- A manual Retry button is omitted because no frontend retry API currently exists.
- Automatic retry evidence remains visible: attempt number, retry-scheduled event, safe code, delay, and next-attempt time when returned by the existing API.
- Delivery is phased and stops for user review after every phase.

## Approaches Considered

### 1. Isolated, conditionally mounted UI trees — selected

A new experience switch conditionally mounts either the existing `Home` tree or a new `OmsWorkspace` tree. The New OMS components consume the existing read-only frontend services.

This preserves the Classic components, prevents duplicate network activity, and gives the new design its own component and CSS boundaries. Switching modes intentionally creates a fresh mount of the selected experience.

### 2. Shared controller with two visual renderers — rejected

A shared state/controller layer could preserve list selection and loaded data across mode changes. It would require extracting behavior from `Home`, `DryRunJourney`, and `ShipmentActivityLog`, modifying the current UI and increasing regression risk. That conflicts with the requirement to leave Classic untouched.

### 3. Restyle the current components with CSS — rejected

A CSS-only skin would be quicker but cannot cleanly produce the OMS table, shipment-detail page, tabbed evidence, and activity drawer. It would also couple the old and new designs and make gradual review difficult.

## Architecture

`App.jsx` receives the only required integration edit to an existing production file: it renders a new `ExtensionExperience` component instead of rendering `Home` directly. `ExtensionExperience` owns the segmented switch and conditionally renders exactly one child:

```text
App
└── ExtensionExperience
    ├── Classic selected → existing Home
    └── New OMS selected → new OmsWorkspace
```

No existing component under `components/dry-run`, `components/activity`, or `pages/Home.jsx` is modified, and no new package dependency is introduced.

The selected mode is stored in `localStorage` under a versioned key scoped by company and application. Only the exact values `classic` and `oms` are accepted. Missing, unreadable, or invalid storage falls back to `classic`. Storage failure never prevents the UI from rendering.

The switch sits in the first row controlled by the extension. The black Fynd platform header and other host-owned chrome are outside the extension iframe and are not modified.

## New OMS Information Architecture

### Extension header

The extension header contains:

- Product title: **E-Invoicing Shipments**
- A short operations-context subtitle
- Segmented **Classic | New OMS** switch
- A Refresh action for the currently visible New OMS view
- A visible “Last refreshed” time after a successful request

The Refresh action is not shown as a live/polling indicator. While a request is active it is disabled and labelled **Refreshing…**.

### Shipment queues

The workspace uses separate Fynd-style queue tabs rather than merging unrelated cursor streams in the browser:

- **Shipments** — recent shipment activity from `listShipmentActivity`
- **Held** — held dry-run journeys from `listDryRuns`
- **Failures** — failed jobs and pre-job failures from the existing failure-list services

Only the selected queue is fetched. Each queue requests one bounded page initially and exposes its existing cursor through **Load more**. The UI never requests all shipments at once.

Filters and search operate only on the rows already loaded in the active queue. The interface states the loaded row count so it never implies a company-wide backend search.

### Shipment list

The list follows the density and hierarchy of Fynd OMS while using only fields available from the extension APIs:

- Shipment ID
- Document or invoice number when available
- Latest stage and action
- Outcome/status chip
- Last update time
- Safe code when present

Price, item count, SLA, customer name, and other native OMS columns are not fabricated because the current list APIs do not expose them.

Selecting a row opens the shipment detail experience. Keyboard users can focus and activate every row without relying on pointer interaction.

### Shipment details

The detail page uses the same broad pattern as the live Fynd shipment page:

- Back navigation to the active queue
- Shipment identity and compact status summary
- Overview and evidence sections in the main area
- Activity in a right-side drawer

The detail presentation reorganizes, but does not remove, the evidence currently shown by `JourneyDetail` and `ShipmentActivityLog`:

- Normalized shipment snapshot
- Fynd lock request and result
- Exact OEIS request metadata and diagnostic download
- OEIS response and artifact metadata when available
- Blocked, pending, or completed Fynd transition evidence
- Failure category, safe code, and sanitized message
- Automatic retry attempt, delay, and next-attempt timestamp
- Chronological shipment activity
- Technical JSON in collapsed evidence panels rather than dominating the primary view

The main detail hierarchy is:

1. **Overview** — current operational state, shipment/document identifiers, latest update, and safe code.
2. **Journey** — Fynd lock → OEIS submission → artifact → Fynd transition.
3. **Evidence** — current normalized and technical request/response details.
4. **Activity drawer** — chronological event history with load-older support.

### Existing actions only

The New OMS UI may expose only actions already supported by the frontend services:

- Refresh the active list
- Refresh the selected detail
- Load more shipments or older activity
- Download diagnostic OEIS request JSON
- Copy the pod cURL when the current safety eligibility rules allow it

Copying the pod cURL retains a prominent warning that executing it performs a real OEIS submission. The UI does not add Retry, Reprocess, Unlock, Approve, Submit, Reconcile, Import response, or invoice-transition controls.

## Data Loading and State

### List lifecycle

1. Mount New OMS or change the active queue.
2. Fetch the first bounded page once.
3. Render loading, success, empty, unauthorized, or retryable-error state.
4. Make no further request until the operator acts.
5. Refresh replaces the active queue with a newly fetched first page.
6. Load more appends one cursor page and updates the cursor.

If Refresh fails while verified rows are already visible, the rows remain on screen and a non-destructive warning explains that the last loaded data is still being shown.

### Detail lifecycle

1. Selecting a row fetches that shipment timeline once.
2. If the row has a job ID, fetch its dry-run journey once in parallel.
3. Route/mode/selection generation guards prevent stale responses from replacing the current selection.
4. Detail Refresh repeats only the selected shipment requests.
5. Closing the detail returns to the already loaded queue without refetching it.

No New OMS component calls `setInterval`, schedules a delayed refresh, or refreshes on `visibilitychange`. Backend job execution and backend automatic retries remain independent of this UI behavior.

### Mode switching

- Switching from Classic to New OMS unmounts Classic, allowing its existing cleanup to stop its polling timers, then performs the New OMS initial fetch.
- Switching from New OMS to Classic unmounts New OMS and mounts Classic fresh. Classic then behaves exactly as it does today, including its existing polling.
- New OMS list selection and loaded pages are not preserved after it is unmounted. This is the intentional isolation trade-off for leaving Classic unchanged.

## Visual Direction

The New OMS experience mirrors the platform’s interaction language without attempting to recreate host-owned navigation:

- Light neutral page background and white content surfaces
- Compact bordered table rows and restrained dividers
- Purple primary accent for selected tabs, the segmented switch, focus, and primary actions
- Semantic green, amber, red, and blue status chips
- Inter/system sans-serif for interface text and monospace only for identifiers or technical evidence
- Fynd-like inner page header, filter toolbar, queue tabs, shipment summary, and activity drawer
- Raw JSON and long request data placed behind disclosure controls

The layout remains usable at common extension iframe widths. The table becomes a stacked shipment list on narrow screens, the detail sidebar moves below the summary, and the activity drawer uses the full viewport width on mobile-sized frames.

## Accessibility

- The experience switch and queue tabs use explicit selected state and keyboard navigation.
- Status is conveyed by text as well as colour.
- Loading and refresh results use polite live regions; session expiry uses an alert.
- The activity drawer traps focus while open, closes with Escape, restores focus to its trigger, and has an accessible name.
- All controls have visible focus styling and a minimum practical hit target.
- Dense identifiers wrap or truncate with an accessible full value.
- Reduced-motion preferences disable nonessential transitions.

## Error and Session Handling

- `401` produces a terminal reauthentication state for the current New OMS mount; Refresh is disabled until the platform session is restored through a remount/navigation.
- `404` on selected detail returns a clear “shipment evidence unavailable” state without deleting the list row.
- Other failures retain verified data where possible and let the operator attempt the read request again through Refresh.
- Error messages remain sanitized; raw Axios/server objects are never rendered.
- A request result is ignored after mode, route, queue, or selection changes.

## Component Boundaries

All new production UI lives under `frontend/components/oms/`:

- `ExtensionExperience.jsx` — mode persistence and conditional mounting
- `ExperienceSwitch.jsx` — accessible Classic/New OMS segmented switch
- `OmsWorkspace.jsx` — queue/detail routing and manual refresh coordination
- `OmsHeader.jsx` — title, view context, Refresh, and last-refreshed state
- `ShipmentQueueTabs.jsx` — active queue selection and loaded counts
- `ShipmentFilters.jsx` — loaded-row search and stage/outcome filters
- `ShipmentTable.jsx` — desktop table and narrow-screen row layout
- `ShipmentStatusChip.jsx` — centralized evidence-to-display status mapping
- `ShipmentDetail.jsx` — detail page composition and back navigation
- `ShipmentSummary.jsx` — identity and current evidence summary
- `ShipmentJourney.jsx` — Fynd/OEIS/transition journey visualization
- `ShipmentEvidence.jsx` — structured and collapsed technical evidence
- `ShipmentActivityDrawer.jsx` — chronological activity and older-page loading
- `OmsStateView.jsx` — loading, empty, warning, error, and unauthorized states
- `oms.css` — isolated `oms-` prefixed styling and responsive rules

Data-loading state is owned by these new React components, which call only the existing `dryRunApi.js` and `shipmentActivityApi.js` exports. No service or backend modification is part of this design.

## Phased Delivery

### Phase 1 — Experience switch and empty OMS shell

- Add the segmented switch and scoped persistence.
- Conditionally mount Classic or New OMS, never both.
- Add the New OMS header and empty shell with no data requests.
- Prove Classic components remain unchanged and no Classic polling continues while New OMS is active.
- Review the shell visually before continuing.

### Phase 2 — Paginated shipment list

- Add the Shipments queue using one initial `listShipmentActivity` request.
- Add manual list Refresh, Last refreshed, Load more, loaded-row search/filtering, and table/mobile layouts.
- Review list density, labels, status chips, and responsive behavior.

### Phase 3 — Shipment detail and activity drawer

- Add shipment selection, summary, timeline request, journey strip, and activity drawer.
- Add independent detail Refresh and older-activity pagination.
- Review the list-to-detail interaction against Fynd OMS.

### Phase 4 — Held/failure evidence and existing actions

- Add Held and Failures queues using their current endpoints.
- Add dry-run journey evidence, diagnostic JSON download, and eligible pod cURL copying.
- Display automatic retry evidence without a manual Retry control.
- Review safety copy and evidence completeness against the Classic UI.

### Phase 5 — Quality pass

- Complete keyboard, focus, reduced-motion, empty/error/session, narrow-width, and stale-response checks.
- Run the full frontend tests and production build.
- Compare Classic behavior and network activity before final acceptance.

Each phase keeps its own verification checkpoint. After Phase 1 was accepted, the user explicitly
approved continuous implementation of Phases 2–5, so those phases may proceed without an
additional pause between them.

## Verification Strategy

New tests are added under `frontend/test/components/oms/`, plus the minimal `App` integration test changes required by the new wrapper.

The tests verify:

- Default Classic selection and valid per-route persistence
- Exactly one experience mounted at a time
- Switching to New OMS unmounts Classic
- No timers, polling, or visibility refresh in New OMS
- One bounded initial list request and cursor-based Load more
- Manual Refresh replacement behavior and last-refreshed state
- Selection race protection and back navigation
- Timeline and optional journey fetch behavior
- Existing-data retention after transient request failure
- Terminal unauthorized handling
- No manual Retry control
- Existing download/copy safety eligibility
- Activity drawer focus behavior
- Keyboard and responsive semantic structure

Each phase ends with its focused Jest tests, the affected existing frontend tests, `npm test -- --runInBand`, and `npm run build`. Browser verification uses the actual extension route at representative wide, medium, and narrow iframe widths.

## Acceptance Criteria

The feature is complete when:

- Operators can reliably switch between an unchanged Classic UI and the New OMS UI.
- New OMS never polls and never loads an unbounded shipment collection.
- A shipment list can be paged manually and refreshed explicitly.
- Selecting a shipment reveals all existing safe journey, failure, retry, OEIS, transition, and activity evidence available through current APIs.
- Only existing read-only actions are exposed.
- The experience visually follows Fynd OMS list/detail/activity patterns and remains accessible and responsive.
- No backend, service contract, processing functionality, or Classic component behavior changes.
