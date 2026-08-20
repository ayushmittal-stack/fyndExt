import React, { useRef } from 'react';
import { QUEUE_IDS, queueLabel } from './omsModel';

const QUEUES = [QUEUE_IDS.SHIPMENTS, QUEUE_IDS.HELD, QUEUE_IDS.FAILURES];
export function ShipmentQueueTabs({ activeQueue, counts = {}, onChange }) {
  const tabsRef = useRef([]);
  const move = (event, nextIndex) => {
    event.preventDefault();
    const queue = QUEUES[nextIndex];
    onChange(queue);
    tabsRef.current[nextIndex]?.focus();
  };
  return <div className="oms-tabs" role="tablist" aria-label="Shipment queues">
    {QUEUES.map((queue, index) => <button
      key={queue} ref={element => { tabsRef.current[index] = element; }} className="oms-tab" type="button"
      role="tab" id={`oms-tab-${queue}`} aria-selected={activeQueue === queue}
      aria-controls="oms-queue-panel" tabIndex={activeQueue === queue ? 0 : -1}
      onClick={() => onChange(queue)}
      onKeyDown={event => {
        if (event.key === 'ArrowRight') move(event, (index + 1) % QUEUES.length);
        if (event.key === 'ArrowLeft') move(event, (index + QUEUES.length - 1) % QUEUES.length);
        if (event.key === 'Home') move(event, 0);
        if (event.key === 'End') move(event, QUEUES.length - 1);
      }}
    >{queueLabel(queue)} <span aria-label={`${counts[queue] || 0} loaded`}>{counts[queue] || 0}</span></button>)}
  </div>;
}
