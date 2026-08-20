# New OMS UI Phase 1 Switch and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible, persisted Classic/New OMS experience switch and a visually complete New OMS shell while mounting only one experience and making no New OMS data request.

**Architecture:** A new `ExtensionExperience` component is the conditional-mount boundary. It renders the untouched `Home` component for Classic mode or the new `OmsWorkspace` for New OMS mode, with a shared extension-owned switch above either branch. The selected value is validated and persisted per company/application in `localStorage`.

**Tech Stack:** React 18, React Router 6, plain CSS, Jest 29, React Testing Library, Vite 5

**Spec:** `docs/superpowers/specs/2026-08-19-new-oms-extension-ui-design.md`

## Global Constraints

- Do not edit `frontend/pages/Home.jsx` or any file under `frontend/components/dry-run/` or `frontend/components/activity/`.
- New OMS must not call any API, use `setInterval`, schedule a delayed refresh, or subscribe to `visibilitychange` in Phase 1.
- Render exactly one of Classic or New OMS; never hide a still-mounted tree with CSS.
- Default to Classic when storage is missing, invalid, unreadable, or unwritable.
- Persist only exact `classic` or `oms` values in a versioned key scoped by company and application.
- Add no dependency and make no backend or service change.
- Prefix all new CSS selectors with `oms-` or `extension-experience-`.
- Do not create implementation commits. Leave the plan and all Phase 1 changes uncommitted for user review.

## File Map

- Create `frontend/components/oms/ExperienceSwitch.jsx`: controlled, accessible segmented switch.
- Create `frontend/components/oms/OmsWorkspace.jsx`: static Phase 1 New OMS header and empty shipment shell.
- Create `frontend/components/oms/ExtensionExperience.jsx`: route-scoped storage, switch state, and conditional mounting.
- Create `frontend/components/oms/oms.css`: isolated platform-inspired shell and responsive styles.
- Create `frontend/test/components/oms/ExperienceSwitch.spec.js`: presentational switch behavior.
- Create `frontend/test/components/oms/ExtensionExperience.spec.js`: defaulting, persistence, isolation, and timer cleanup.
- Create `frontend/test/components/oms/OmsWorkspace.spec.js`: Phase 1 shell semantics and explicit no-service/no-timer coverage.
- Modify `frontend/App.jsx`: replace direct `Home` rendering with `ExtensionExperience`.
- Modify `frontend/test/App.spec.js`: assert the new application boundary is mounted.

---

### Task 1: Build the accessible switch and static OMS shell

**Files:**
- Create: `frontend/components/oms/ExperienceSwitch.jsx`
- Create: `frontend/components/oms/OmsWorkspace.jsx`
- Create: `frontend/components/oms/oms.css`
- Test: `frontend/test/components/oms/ExperienceSwitch.spec.js`
- Test: `frontend/test/components/oms/OmsWorkspace.spec.js`

**Interfaces:**
- Consumes: `mode: 'classic' | 'oms'`, `onChange(nextMode)`
- Produces: `ExperienceSwitch({ mode, onChange })` and `OmsWorkspace()`

- [x] **Step 1: Write the failing switch tests**

Create `frontend/test/components/oms/ExperienceSwitch.spec.js` with tests that render `ExperienceSwitch`, assert the group label **Choose extension experience**, assert selected state through `aria-pressed`, and click **New OMS** to expect `onChange('oms')` exactly once.

```jsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { ExperienceSwitch } from '../../../components/oms/ExperienceSwitch';

describe('ExperienceSwitch', () => {
  test('announces the selected experience', () => {
    render(<ExperienceSwitch mode="classic" onChange={() => {}} />);

    expect(screen.getByRole('group', { name: 'Choose extension experience' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Classic' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'New OMS' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('requests a mode change once', () => {
    const onChange = jest.fn();
    render(<ExperienceSwitch mode="classic" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('oms');
  });
});
```

- [x] **Step 2: Write the failing OMS shell test**

Create `frontend/test/components/oms/OmsWorkspace.spec.js`. Assert the Phase 1 title, supporting copy, empty-shell status, and absence of Refresh or Retry controls.

```jsx
import React from 'react';
import { render, screen } from '@testing-library/react';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';

test('renders the static Phase 1 OMS shell without operational actions', () => {
  render(<OmsWorkspace />);

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.getByText('Shipment operations, arranged like Fynd OMS.')).toBeInTheDocument();
  expect(screen.getByText('Shipment workspace')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
});
```

- [x] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
cd frontend && npm test -- --runInBand test/components/oms/ExperienceSwitch.spec.js test/components/oms/OmsWorkspace.spec.js
```

Expected: both suites fail because the two component modules do not exist.

- [x] **Step 4: Implement the presentational components**

Implement `ExperienceSwitch.jsx` as two native buttons inside a labelled group. Clicking the already-selected button must be a no-op. Implement `OmsWorkspace.jsx` as semantic `main` content with a Fynd-like inner page header and honest empty shell. Both files import only React; neither imports a service. `ExtensionExperience.jsx` loads `oms.css` in Task 2.

```jsx
import React from 'react';

export function ExperienceSwitch({ mode, onChange }) {
  const options = [
    { value: 'classic', label: 'Classic' },
    { value: 'oms', label: 'New OMS' },
  ];

  return (
    <div className="extension-experience-switch" role="group" aria-label="Choose extension experience">
      {options.map(option => {
        const selected = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            className={`extension-experience-switch__option${selected ? ' is-selected' : ''}`}
            aria-pressed={selected}
            onClick={() => { if (!selected) onChange(option.value); }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
```

Create `OmsWorkspace.jsx` with the exact visible copy asserted by the tests and an `aria-labelledby` relationship from `main` to the `h1`:

```jsx
import React from 'react';

export function OmsWorkspace() {
  return (
    <main className="oms-workspace" aria-labelledby="oms-workspace-title">
      <header className="oms-page-header">
        <div>
          <p className="oms-page-header__eyebrow">Invoice operations</p>
          <h1 id="oms-workspace-title">E-Invoicing Shipments</h1>
          <p className="oms-page-header__supporting">
            Shipment operations, arranged like Fynd OMS.
          </p>
        </div>
        <span className="oms-page-header__phase">New experience preview</span>
      </header>

      <section className="oms-empty-shell" aria-labelledby="oms-empty-shell-title">
        <div className="oms-empty-shell__route" aria-hidden="true">
          <span className="oms-empty-shell__node" />
          <span className="oms-empty-shell__line" />
          <span className="oms-empty-shell__node is-active" />
          <span className="oms-empty-shell__line" />
          <span className="oms-empty-shell__node" />
        </div>
        <p className="oms-empty-shell__eyebrow">Phase 1</p>
        <h2 id="oms-empty-shell-title">Shipment workspace</h2>
        <p>The paginated shipment list will be introduced after this shell is reviewed.</p>
      </section>
    </main>
  );
}
```

- [x] **Step 5: Add isolated platform-inspired styling**

Create `oms.css` with isolated selectors. Do not style bare elements such as `button`, `h1`, or `body`.

```css
.extension-experience-bar,
.extension-experience-switch,
.extension-experience-switch__option,
.oms-workspace,
.oms-page-header,
.oms-empty-shell {
  box-sizing: border-box;
}

.extension-experience-bar {
  align-items: center;
  background: #ffffff;
  border-bottom: 1px solid #e5e3e9;
  display: flex;
  justify-content: space-between;
  min-height: 64px;
  padding: 10px 24px;
}

.extension-experience-bar__identity {
  display: grid;
  gap: 2px;
}

.extension-experience-bar__label {
  color: #777180;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.extension-experience-bar__title {
  color: #241d2d;
  font-size: 1.75rem;
  font-weight: 650;
}

.extension-experience-root.is-oms {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.extension-experience-root.is-oms .extension-experience-bar {
  flex: 0 0 auto;
}

.extension-experience-switch {
  align-items: center;
  background: #f1eff4;
  border: 1px solid #ded9e5;
  border-radius: 8px;
  display: inline-flex;
  gap: 2px;
  padding: 3px;
}

.extension-experience-switch__option {
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: #655e6e;
  cursor: pointer;
  font: inherit;
  font-size: 1.5rem;
  font-weight: 600;
  min-height: 44px;
  padding: 0 16px;
}

.extension-experience-switch__option.is-selected {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(40, 27, 54, 0.14);
  color: #5b2a86;
}

.extension-experience-switch__option:focus-visible {
  box-shadow: 0 0 0 3px rgba(91, 42, 134, 0.24);
  outline: 2px solid #5b2a86;
  outline-offset: 2px;
}

.oms-workspace {
  --oms-accent: #5b2a86;
  --oms-border: #e3e0e7;
  --oms-ink: #241d2d;
  --oms-muted: #6e6875;
  background: #f5f4f7;
  color: var(--oms-ink);
  padding: 24px;
}

.extension-experience-root.is-oms .oms-workspace {
  flex: 1 1 auto;
  min-height: 0;
}

.oms-page-header {
  align-items: flex-start;
  display: flex;
  gap: 24px;
  justify-content: space-between;
  margin: 0 auto 16px;
  max-width: 1440px;
}

.oms-page-header__eyebrow,
.oms-empty-shell__eyebrow {
  color: var(--oms-accent);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.oms-page-header h1 {
  font-size: 3rem;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0;
}

.oms-page-header__supporting {
  color: var(--oms-muted);
  font-size: 1.75rem;
  line-height: 1.5;
  margin: 8px 0 0;
}

.oms-page-header__phase {
  background: #eee7f5;
  border: 1px solid #d8c9e7;
  border-radius: 999px;
  color: var(--oms-accent);
  font-size: 1.375rem;
  font-weight: 650;
  padding: 8px 12px;
  white-space: nowrap;
}

.oms-empty-shell {
  align-items: center;
  background: #ffffff;
  border: 1px solid var(--oms-border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  margin: 0 auto;
  max-width: 1440px;
  min-height: 420px;
  padding: 48px 24px;
  text-align: center;
}

.oms-empty-shell__route {
  align-items: center;
  display: flex;
  justify-content: center;
  margin-bottom: 22px;
}

.oms-empty-shell__node {
  background: #ffffff;
  border: 2px solid #aaa3b2;
  border-radius: 50%;
  height: 12px;
  width: 12px;
}

.oms-empty-shell__node.is-active {
  background: var(--oms-accent);
  border-color: var(--oms-accent);
  box-shadow: 0 0 0 5px #eee7f5;
}

.oms-empty-shell__line {
  background: #d8d3de;
  height: 2px;
  width: 44px;
}

.oms-empty-shell h2 {
  font-size: 2.25rem;
  margin: 0;
}

.oms-empty-shell > p:last-child {
  color: var(--oms-muted);
  font-size: 1.625rem;
  line-height: 1.5;
  margin: 10px 0 0;
  max-width: 520px;
}

@media (max-width: 720px) {
  .extension-experience-bar,
  .oms-page-header {
    align-items: stretch;
    flex-direction: column;
  }

  .extension-experience-bar {
    padding: 12px 16px;
  }

  .extension-experience-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: 100%;
  }

  .oms-workspace {
    padding: 18px 14px;
  }

  .oms-page-header__phase {
    align-self: flex-start;
  }

  .oms-empty-shell {
    min-height: 340px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .extension-experience-switch__option {
    transition: none;
  }
}
```

- [x] **Step 6: Run the focused tests and verify they pass**

Run the same focused Jest command from Step 3.

Expected: both suites pass with no timer or network mocks required.

- [x] **Step 7: Review the uncommitted Task 1 diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only the new Task 1 files and the uncommitted plan are listed; do not commit them.

---

### Task 2: Add route-scoped mode persistence and mount isolation

**Files:**
- Create: `frontend/components/oms/ExtensionExperience.jsx`
- Test: `frontend/test/components/oms/ExtensionExperience.spec.js`

**Interfaces:**
- Consumes: `useParams()` values `company_id` and optional `application_id`; `Home`; `OmsWorkspace`; `ExperienceSwitch`
- Produces: `ExtensionExperience()` and storage key `sgh-einvoice:ui-mode:v1:<company>:<application-or-company>`

- [x] **Step 1: Write failing isolation and persistence tests**

Create `frontend/test/components/oms/ExtensionExperience.spec.js`. Mock `Home` with a component that starts one interval and clears it on unmount. Render `ExtensionExperience` inside a `MemoryRouter` route `/company/:company_id/application/:application_id`.

```jsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ExtensionExperience } from '../../../components/oms/ExtensionExperience';

jest.mock('../../../pages/Home', () => {
  const ReactModule = require('react');
  return {
    Home: () => {
      ReactModule.useEffect(() => {
        const timer = setInterval(() => {}, 5000);
        return () => clearInterval(timer);
      }, []);
      return ReactModule.createElement('div', { 'data-testid': 'classic-home' }, 'Classic Home');
    },
  };
});

function renderExperience(initialEntry = '/company/12/application/34') {
  return render(
    <MemoryRouter
      initialEntries={[initialEntry]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route
          path="/company/:company_id/application/:application_id"
          element={<ExtensionExperience />}
        />
        <Route path="/company/:company_id/" element={<ExtensionExperience />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('defaults to Classic and mounts only Home', () => {
  renderExperience();

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'E-Invoicing Shipments' })).not.toBeInTheDocument();
});

test('switches to OMS and unmounts the Classic timer', () => {
  jest.useFakeTimers();
  renderExperience();
  expect(jest.getTimerCount()).toBe(1);

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(jest.getTimerCount()).toBe(0);
});

test('restores OMS only for the matching company and application', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');

  renderExperience();

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
});

test('falls back to Classic for an invalid stored value', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'future');

  renderExperience();

  expect(screen.getByTestId('classic-home')).toBeInTheDocument();
});

test('continues in memory when localStorage.setItem throws', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  renderExperience();

  fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.queryByTestId('classic-home')).not.toBeInTheDocument();
});
```

The mock deliberately uses `ReactModule` because Jest hoists the mock factory. Use fake timers only in the timer-cleanup test and restore real timers after every test.

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd frontend && npm test -- --runInBand test/components/oms/ExtensionExperience.spec.js
```

Expected: FAIL because `ExtensionExperience.jsx` does not exist.

- [x] **Step 3: Implement validated route-scoped persistence**

Create `ExtensionExperience.jsx` with these exact helpers and a keyed route-scoped child:

```jsx
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';

import { Home } from '../../pages/Home';
import { ExperienceSwitch } from './ExperienceSwitch';
import { OmsWorkspace } from './OmsWorkspace';
import './oms.css';

const CLASSIC = 'classic';
const OMS = 'oms';

function storageKey(companyId, applicationId) {
  return `sgh-einvoice:ui-mode:v1:${String(companyId)}:${applicationId === undefined ? 'company' : String(applicationId)}`;
}

function readMode(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value === OMS ? OMS : CLASSIC;
  } catch {
    return CLASSIC;
  }
}

function writeMode(key, mode) {
  try {
    window.localStorage.setItem(key, mode);
  } catch {
    // In-memory selection remains usable when storage is unavailable.
  }
}

function RouteScopedExperience({ preferenceKey }) {
  const [mode, setMode] = useState(() => readMode(preferenceKey));

  const chooseMode = nextMode => {
    if (nextMode !== CLASSIC && nextMode !== OMS) return;
    setMode(nextMode);
    writeMode(preferenceKey, nextMode);
  };

  return (
    <div className={`extension-experience-root${mode === OMS ? ' is-oms' : ''}`}>
      <header className="extension-experience-bar">
        <div className="extension-experience-bar__identity">
          <span className="extension-experience-bar__label">Extension view</span>
          <strong className="extension-experience-bar__title">Invoice operations</strong>
        </div>
        <ExperienceSwitch mode={mode} onChange={chooseMode} />
      </header>
      {mode === CLASSIC ? <Home /> : <OmsWorkspace />}
    </div>
  );
}

export function ExtensionExperience() {
  const { application_id: applicationId, company_id: companyId } = useParams();
  const preferenceKey = storageKey(companyId, applicationId);
  return <RouteScopedExperience key={preferenceKey} preferenceKey={preferenceKey} />;
}
```

The keyed child resets the selected mode synchronously when route params change. Do not render both branches and do not use CSS hiding.

- [x] **Step 4: Run the focused test and verify it passes**

Run the Step 2 command.

Expected: all route isolation, storage failure, route-change, and timer-cleanup cases pass.

- [x] **Step 5: Run all new OMS tests together**

Run:

```bash
cd frontend && npm test -- --runInBand test/components/oms
```

Expected: all Phase 1 OMS suites pass.

- [x] **Step 6: Review the uncommitted Task 2 diff**

Run `git diff --check` and `git status --short`. Do not stage or commit.

---

### Task 3: Integrate the experience boundary and verify Phase 1

**Files:**
- Modify: `frontend/App.jsx`
- Modify: `frontend/test/App.spec.js`

**Interfaces:**
- Consumes: `ExtensionExperience()` from `frontend/components/oms/ExtensionExperience.jsx`
- Produces: the existing `App` export with the new experience boundary under the unchanged global-style wrapper

- [x] **Step 1: Change the App test first**

Replace `frontend/test/App.spec.js` with this focused integration test:

```jsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import App from '../App';

jest.mock('../pages/Home', () => ({
  Home: () => <div>Classic Home</div>,
}));

afterEach(() => {
  window.localStorage.clear();
});

test('renders the selected route-scoped extension experience', () => {
  window.localStorage.setItem('sgh-einvoice:ui-mode:v1:12:34', 'oms');

  render(
    <MemoryRouter
      initialEntries={['/company/12/application/34']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/company/:company_id/application/:application_id" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
});
```

- [x] **Step 2: Run the App test and verify it fails**

Run:

```bash
cd frontend && npm test -- --runInBand test/App.spec.js
```

Expected: FAIL because `App` still renders `Home` directly.

- [x] **Step 3: Make the minimal App integration edit**

In `frontend/App.jsx`, replace the `Home` import with:

```jsx
import { ExtensionExperience } from './components/oms/ExtensionExperience';
```

Replace `<Home />` with `<ExtensionExperience />`. Leave `globalStyles` and the `.root` wrapper unchanged.

- [x] **Step 4: Run the App and OMS tests**

Run:

```bash
cd frontend && npm test -- --runInBand test/App.spec.js test/components/oms
```

Expected: all Phase 1 suites pass.

- [x] **Step 5: Run the complete frontend verification**

Run:

```bash
cd frontend && npm test -- --runInBand
cd frontend && npm run build
```

Expected: all Phase 1 tests pass; the complete Jest result matches the approved baseline with only the pre-existing `DryRunJourney.spec.js` invoice-ID expectation failing; Vite exits successfully with a production bundle.

- [x] **Step 6: Perform browser verification**

Open the real extension route and verify:

- Classic is selected on first load when no scoped preference exists.
- Classic looks and behaves as before below the new compact switch row.
- Selecting New OMS removes Classic from the DOM and shows the New OMS shell.
- Network activity stops after the static New OMS shell mounts.
- Reload restores New OMS for the same route.
- A different application route defaults independently.
- The switch and shell remain readable at wide, `720px`, and narrow widths.
- Keyboard focus and selected states are visible.

- [x] **Step 7: Present the uncommitted Phase 1 review diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the plan, new OMS files, `frontend/App.jsx`, and `frontend/test/App.spec.js` are changed. Do not stage or commit. Stop for user review before Phase 2.

---

### Review hardening

- [x] Assert clicking the selected experience is a no-op.
- [x] Assert preferences do not leak across companies, applications, or company-level routes.
- [x] Assert route changes synchronously reload the correct scoped preference.
- [x] Assert unreadable storage falls back to Classic.
- [x] Mock the known operational services and assert the static OMS shell calls none of them.
- [x] Assert the OMS shell creates no intervals, delayed work, or visibility listener.
- [x] Use a mode-scoped flex layout instead of fixed header-height viewport arithmetic.
