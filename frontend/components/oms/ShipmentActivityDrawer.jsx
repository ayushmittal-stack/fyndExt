import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { actionLabel, formatUtc, outcomeLabel, stageLabel } from './omsModel';

function focusables(root) { return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]; }

export function ShipmentActivityDrawer({ timeline, cursor, loadingOlder, warning, onLoadOlder, onClose, triggerRef }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    const root = triggerRef?.current?.closest('.extension-experience-root');
    const hadHidden = root?.hasAttribute('aria-hidden');
    const hidden = root?.getAttribute('aria-hidden');
    const hadInert = root?.hasAttribute('inert');
    const inert = root?.inert === true;
    if (root) {
      root.inert = true;
      root.setAttribute('inert', '');
      root.setAttribute('aria-hidden', 'true');
    }
    closeRef.current?.focus();
    return () => {
      if (root) {
        root.inert = inert;
        if (hadInert) root.setAttribute('inert', ''); else root.removeAttribute('inert');
        if (hadHidden) root.setAttribute('aria-hidden', hidden); else root.removeAttribute('aria-hidden');
      }
      triggerRef?.current?.focus();
    };
  }, [triggerRef]);
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = focusables(dialogRef.current);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const drawer = <aside ref={dialogRef} className="oms-activity-drawer" role="dialog" aria-modal="true" aria-labelledby="oms-activity-title" onKeyDown={onKeyDown}>
    <header><h2 id="oms-activity-title">Shipment activity</h2><button ref={closeRef} className="oms-drawer-close" type="button" onClick={onClose}>Close activity</button></header>
    <ol className="oms-activity-list" aria-label="Shipment chronology">{timeline.map(event => <li key={event.key || `${event.occurredAt}:${event.action}`}><time dateTime={event.occurredAt}>{formatUtc(event.occurredAt)}</time><strong>{actionLabel(event.action)}</strong><span>{stageLabel(event.stage)} · {outcomeLabel(event.outcome)}</span></li>)}</ol>
    {warning && <p className="oms-drawer-warning" role="status">{warning}</p>}
    {cursor !== null && <button className="oms-load-older" type="button" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? 'Loading older activity…' : 'Load older activity'}</button>}
  </aside>;
  return createPortal(drawer, document.body);
}
