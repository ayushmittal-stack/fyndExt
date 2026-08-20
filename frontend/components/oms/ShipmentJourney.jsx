import React from 'react';

import { actionLabel, outcomeLabel } from './omsModel';

const STAGES = [
  ['WEBHOOK', 'Webhook'], ['FYND_LOCK', 'Fynd lock'], ['OEIS_SUBMISSION', 'OEIS'], ['OEIS_ARTIFACT', 'Artifact'], ['FYND_TRANSITION', 'Fynd transition'],
];

export function ShipmentJourney({ timeline }) {
  return <section className="oms-journey" aria-labelledby="oms-journey-title">
    <h2 id="oms-journey-title">Journey</h2>
    <ol className="oms-journey-rail" aria-label="Shipment journey">
      {STAGES.map(([stage, label]) => {
        const event = [...timeline].reverse().find(item => item.stage === stage);
        return <li key={stage} className={event ? 'is-reached' : 'is-pending'}><strong>{label}</strong><span>{event ? `${actionLabel(event.action)} · ${outcomeLabel(event.outcome)}` : 'Not reached'}</span></li>;
      })}
    </ol>
  </section>;
}
