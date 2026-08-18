import React from 'react';

function heldTimestamp(lockedAt) {
  const timestamp = Date.parse(lockedAt);
  if (Number.isNaN(timestamp)) return 'Held time unavailable';
  return `Held at ${new Date(timestamp).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  })} UTC`;
}

export function HeldJobList({ jobs, selectedJobId, onSelect }) {
  return (
    <aside className="dry-run-list" aria-label="Held invoice journeys">
      <div className="dry-run-list-heading">
        <span>Held jobs</span>
        <span className="dry-run-list-count">{jobs.length}</span>
      </div>
      <ul className="dry-run-job-list">
        {jobs.map(job => (
          <li className="dry-run-job-item" key={job.jobId}>
            <button
              className={`dry-run-job-button${selectedJobId === job.jobId ? ' dry-run-job-button-selected' : ''}`}
              type="button"
              aria-pressed={selectedJobId === job.jobId}
              onClick={() => onSelect(job.jobId)}
            >
              <span className="dry-run-job-document">{job.documentNumber}</span>
              <span className="dry-run-job-meta">
                Shipment <span className="dry-run-job-value">{job.shipmentId}</span>
              </span>
              <span className="dry-run-job-meta">{heldTimestamp(job.lockedAt)}</span>
              <span className="dry-run-job-state">Submission held</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
