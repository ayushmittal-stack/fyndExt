import React from 'react';

import { outcomeLabel, statusTone } from './omsModel';

export function ShipmentStatusChip({ outcome }) {
  const tone = statusTone(outcome);
  return <span className={`oms-status-chip oms-status-chip--${tone}`}>{outcomeLabel(outcome)}</span>;
}
