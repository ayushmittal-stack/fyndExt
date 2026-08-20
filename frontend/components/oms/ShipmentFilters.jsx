import React from 'react';
import { outcomeLabel, stageLabel } from './omsModel';

export function ShipmentFilters({ filters, onChange, onReset, showing, loaded, rows }) {
  const stages = [...new Set(rows.map(row => row.stage))];
  const outcomes = [...new Set(rows.map(row => row.outcome))];
  return <section className="oms-filters" aria-label="Loaded shipment filters">
    <label>Search loaded shipments<input value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} /></label>
    <label>Stage<select value={filters.stage} onChange={event => onChange({ ...filters, stage: event.target.value })}><option value="">All stages</option>{stages.map(stage => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}</select></label>
    <label>Outcome<select value={filters.outcome} onChange={event => onChange({ ...filters, outcome: event.target.value })}><option value="">All outcomes</option>{outcomes.map(outcome => <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>)}</select></label>
    <button type="button" onClick={onReset}>Reset filters</button>
    <p>Showing {showing} of {loaded} loaded</p>
  </section>;
}
