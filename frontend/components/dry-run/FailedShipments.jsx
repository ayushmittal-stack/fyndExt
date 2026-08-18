import React from 'react';

const TRANSIENT_ERROR = 'Failed-shipment data could not be loaded.';
const REAUTHENTICATE = 'Your session has expired. Reauthenticate in Fynd to inspect held journeys.';
const PRE_JOB_MESSAGE = 'Shipment processing was rejected before a job was created.';

function failureTimestamp(value) {
  return new Date(value).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  });
}

function FailureTime({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><time dateTime={value}>{failureTimestamp(value)} UTC</time></dd>
    </div>
  );
}

function descendingByTime(left, right, field) {
  const byTime = Date.parse(right[field]) - Date.parse(left[field]);
  if (byTime !== 0) return byTime;
  if (Number.isSafeInteger(left.jobId) && Number.isSafeInteger(right.jobId)) {
    return right.jobId - left.jobId;
  }
  return String(right.shipmentId).localeCompare(String(left.shipmentId));
}

export function FailedShipments({
  failures = [],
  loading = false,
  error = null,
  stopped = false,
  nextBeforeId = null,
  loadingOlder = false,
  onLoadOlder,
  preJobFailures = [],
  preJobLoading = false,
  preJobError = null,
  preJobNextBefore = null,
  preJobLoadingOlder = false,
  onLoadOlderPreJob,
  reauthenticationAnnounced = false,
}) {
  const sortedJobFailures = [...failures]
    .sort((left, right) => descendingByTime(left, right, 'failedAt'));
  const jobShipmentIds = new Set(sortedJobFailures.map(item => item.shipmentId));
  const visiblePreJobFailures = preJobFailures
    .filter(item => !jobShipmentIds.has(item.shipmentId))
    .sort((left, right) => descendingByTime(left, right, 'lastOccurredAt'));
  const loadedCount = sortedJobFailures.length + visiblePreJobFailures.length;
  const hasFailures = loadedCount > 0;
  const anyLoading = loading || preJobLoading;
  const anyLoadingOlder = loadingOlder || preJobLoadingOlder;
  const hasError = error || preJobError;

  return (
    <section
      className="failed-shipments"
      aria-labelledby="failed-shipments-title"
      aria-busy={anyLoading || anyLoadingOlder}
    >
      <header className="failed-shipments-heading">
        <div>
          <p className="dry-run-eyebrow">Terminal exception register</p>
          <h2 id="failed-shipments-title">Failed shipments</h2>
        </div>
        <span className="failed-shipments-count">
          {loadedCount} loaded {loadedCount === 1 ? 'failure' : 'failures'}
        </span>
      </header>

      {stopped && !reauthenticationAnnounced && (
        <p className="failed-shipments-state failed-shipments-warning" role="alert">
          {REAUTHENTICATE}
        </p>
      )}
      {stopped && reauthenticationAnnounced && (
        <p className="failed-shipments-state">Failure polling stopped.</p>
      )}
      {!stopped && hasError && (
        <p className="failed-shipments-state failed-shipments-warning" role="alert">
          {TRANSIENT_ERROR}
        </p>
      )}
      {!stopped && anyLoading && !hasFailures && (
        <div
          className="failed-shipments-state dry-run-loading-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <img
            className="dry-run-loading-status__image"
            src="/assets/language-switch-loader.webp"
            alt=""
            aria-hidden="true"
          />
          <span className="dry-run-loading-status__text">Loading failed shipments…</span>
        </div>
      )}
      {!stopped && !anyLoading && !hasError && !hasFailures && (
        <p className="failed-shipments-state">No failed shipments recorded.</p>
      )}

      {!stopped && (
        <div className="failed-shipments-groups">
          <section
            className="failed-shipments-group failed-shipments-prejob-group"
            aria-labelledby="failed-shipments-prejob-title"
          >
            <h3 id="failed-shipments-prejob-title">Rejected before a job was created</h3>
            {visiblePreJobFailures.length > 0 && (
              <ul className="failed-shipments-list failed-shipments-prejob-list">
                {visiblePreJobFailures.map(failure => (
                  <li
                    className="failed-shipment-row failed-shipment-row-rejected failed-shipment-prejob"
                    key={`prejob:${failure.shipmentId}`}
                  >
                    <div className="failed-shipment-identity">
                      <span className="failed-shipment-shipment">
                        Shipment <span className="failed-shipment-mono">{failure.shipmentId}</span>
                      </span>
                    </div>
                    <div className="failed-shipment-cause">
                      <span className="failed-shipment-state-chip failed-shipment-state-rejected">
                        REJECTED BEFORE JOB
                      </span>
                      <span className="failed-shipment-code">{failure.lastSafeCode}</span>
                      <p>{PRE_JOB_MESSAGE}</p>
                    </div>
                    <dl className="failed-shipment-metadata">
                      <FailureTime label="Received" value={failure.firstOccurredAt} />
                      <FailureTime label="Rejected" value={failure.lastOccurredAt} />
                    </dl>
                  </li>
                ))}
              </ul>
            )}
            {preJobNextBefore !== null && (
              <div className="failed-shipments-pagination">
                <button
                  className="dry-run-button failed-shipments-load"
                  type="button"
                  disabled={preJobLoadingOlder}
                  onClick={onLoadOlderPreJob}
                >
                  {preJobLoadingOlder
                    ? 'Loading older pre-job failures…'
                    : 'Load older pre-job failures'}
                </button>
              </div>
            )}
          </section>

          <section
            className="failed-shipments-group failed-shipments-job-group"
            aria-labelledby="failed-shipments-job-title"
          >
            <h3 id="failed-shipments-job-title">Job failures</h3>
            {sortedJobFailures.length > 0 && (
              <ul className="failed-shipments-list failed-shipments-job-list">
                {sortedJobFailures.map(failure => (
                  <li
                    className={`failed-shipment-row failed-shipment-row-${failure.state.toLowerCase()}`}
                    key={`job:${failure.jobId}`}
                  >
                    <div className="failed-shipment-identity">
                      <span className="failed-shipment-document">
                        {failure.documentNumber === null ? 'Document not assigned' : failure.documentNumber}
                      </span>
                      <span className="failed-shipment-shipment">
                        Shipment <span className="failed-shipment-mono">{failure.shipmentId}</span>
                      </span>
                    </div>
                    <div className="failed-shipment-cause">
                      <span className={`failed-shipment-state-chip failed-shipment-state-${failure.state.toLowerCase()}`}>
                        {failure.state}
                      </span>
                      <span className="failed-shipment-code">{failure.failureCode}</span>
                      <p>{failure.failureMessage}</p>
                    </div>
                    <dl className="failed-shipment-metadata">
                      <div><dt>Attempts</dt><dd>{failure.attemptCount}</dd></div>
                      <FailureTime label="Created" value={failure.createdAt} />
                      <FailureTime label="Failed" value={failure.failedAt} />
                      {failure.lockRecordedAt !== null && (
                        <FailureTime label="Lock recorded" value={failure.lockRecordedAt} />
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
            {nextBeforeId !== null && (
              <div className="failed-shipments-pagination">
                <button
                  className="dry-run-button failed-shipments-load"
                  type="button"
                  disabled={loadingOlder}
                  onClick={onLoadOlder}
                >
                  {loadingOlder ? 'Loading older job failures…' : 'Load older job failures'}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
