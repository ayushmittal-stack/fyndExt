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
