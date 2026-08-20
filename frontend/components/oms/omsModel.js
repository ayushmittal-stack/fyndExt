export const QUEUE_IDS = Object.freeze({
  SHIPMENTS: 'shipments',
  HELD: 'held',
  FAILURES: 'failures',
});

const STAGE_LABELS = Object.freeze({
  WEBHOOK: 'Webhook receipt', JOB: 'Shipment job', VALIDATION: 'Local validation',
  PAYLOAD: 'Invoice payload', FYND_LOCK: 'Fynd invoice lock',
  OEIS_SUBMISSION: 'OEIS submission', OEIS_ARTIFACT: 'OEIS artifact',
  OUTBOX: 'Outbox delivery', FYND_TRANSITION: 'Fynd shipment transition',
  RETRY: 'Retry scheduling', LEASE: 'Lease recovery', MIGRATION: 'Legacy migration',
});
const ACTION_LABELS = Object.freeze({
  WEBHOOK_RECEIVED: 'Webhook received', WEBHOOK_ACCEPTED: 'Webhook accepted',
  WEBHOOK_DUPLICATE: 'Duplicate webhook recognized', WEBHOOK_IGNORED: 'Webhook ignored',
  WEBHOOK_REJECTED: 'Webhook rejected', JOB_CLAIMED: 'Job claimed',
  VALIDATION_STARTED: 'Local validation started', VALIDATION_PASSED: 'Local validation passed',
  VALIDATION_FAILED: 'Local validation failed', PAYLOAD_PREPARED: 'Invoice payload prepared',
  FYND_LOCK_REQUESTED: 'Fynd invoice lock requested', FYND_LOCK_CONFIRMED: 'Fynd invoice lock confirmed',
  FYND_LOCK_FAILED: 'Fynd invoice lock failed', FYND_LOCK_READBACK: 'Fynd invoice lock readback',
  OEIS_SUBMISSION_HELD: 'OEIS submission held', OEIS_SUBMISSION_REQUESTED: 'OEIS submission requested',
  OEIS_RESPONSE_RECEIVED: 'OEIS response received', OEIS_SUBMISSION_FAILED: 'OEIS submission failed',
  OEIS_ARTIFACT_STORED: 'OEIS artifact stored', OUTBOX_CLAIMED: 'Outbox claimed',
  FYND_TRANSITION_REQUESTED: 'Fynd shipment transition requested',
  FYND_TRANSITION_CONFIRMED: 'Fynd shipment transition confirmed',
  FYND_TRANSITION_FAILED: 'Fynd shipment transition failed',
  FYND_TRANSITION_READBACK: 'Fynd shipment transition readback', RETRY_SCHEDULED: 'Retry scheduled',
  LEASE_RECOVERED: 'Lease recovered', JOB_DATA_FAILED: 'Job data failed',
  JOB_INDETERMINATE: 'Job indeterminate', JOB_COMPLETED: 'Job completed',
  LEGACY_STATE_IMPORTED: 'Legacy state imported',
});
const OUTCOME_LABELS = Object.freeze({
  STARTED: 'Started', SUCCESS: 'Success', FAILURE: 'Failure', TIMEOUT: 'Timeout',
  RETRY_SCHEDULED: 'Retry scheduled', HELD: 'Held', INDETERMINATE: 'Indeterminate',
});
const UTC_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hour12: false,
});

export function queueLabel(queue) {
  return { shipments: 'Shipments', held: 'Held', failures: 'Failures' }[queue] || 'Queue';
}
export function stageLabel(stage) { return STAGE_LABELS[stage] || 'Stage unavailable'; }
export function actionLabel(action) { return ACTION_LABELS[action] || 'Action unavailable'; }
export function outcomeLabel(outcome) { return OUTCOME_LABELS[outcome] || 'Status unavailable'; }
export function statusTone(outcome) {
  if (outcome === 'SUCCESS') return 'success';
  if (outcome === 'FAILURE') return 'failure';
  if (outcome === 'TIMEOUT') return 'timeout';
  if (outcome === 'HELD') return 'held';
  if (outcome === 'RETRY_SCHEDULED') return 'info';
  if (outcome === 'STARTED') return 'started';
  return 'indeterminate';
}
export function formatUtc(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : `${UTC_FORMATTER.format(date)} UTC`;
}
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Duration unavailable';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const decimal = value => value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  if (milliseconds < 60000) return `${decimal(milliseconds / 1000)} s`;
  return `${Math.floor(milliseconds / 60000)} min ${decimal((milliseconds % 60000) / 1000)} s`;
}

function row(values) {
  return { key: eventIdentity(values), failureMessage: null, attemptCount: null, raw: values.raw, ...values };
}
export function normalizeShipmentRow(item) {
  return row({ key: `shipments:${item.shipmentId}:${item.jobId ?? ''}`, source: QUEUE_IDS.SHIPMENTS,
    shipmentId: item.shipmentId, jobId: item.jobId, documentNumber: item.documentNumber,
    stage: item.lastStage, action: item.lastAction, outcome: item.lastOutcome,
    safeCode: item.lastSafeCode, updatedAt: item.lastOccurredAt, raw: item });
}
export function normalizeHeldRow(item) {
  return row({ key: `held:${item.jobId}`, source: QUEUE_IDS.HELD, shipmentId: item.shipmentId,
    jobId: item.jobId, documentNumber: item.documentNumber, stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD', safeCode: null,
    updatedAt: item.lockedAt || item.createdAt, raw: item });
}
export function normalizeJobFailureRow(item) {
  const isIndeterminate = item.state === 'INDETERMINATE';
  return row({ key: `failures:job:${item.jobId}`, source: QUEUE_IDS.FAILURES, shipmentId: item.shipmentId,
    jobId: item.jobId, documentNumber: item.documentNumber, state: item.state, stage: 'JOB',
    action: isIndeterminate ? 'JOB_INDETERMINATE' : 'JOB_DATA_FAILED',
    outcome: isIndeterminate ? 'INDETERMINATE' : 'FAILURE', safeCode: item.failureCode,
    updatedAt: item.failedAt, failureMessage: item.failureMessage, attemptCount: item.attemptCount, raw: item });
}
export function normalizePreJobFailureRow(item) {
  return row({ key: `failures:prejob:${item.shipmentId}`, source: QUEUE_IDS.FAILURES,
    shipmentId: item.shipmentId, jobId: null, documentNumber: null, stage: item.lastStage,
    action: item.lastAction, outcome: item.lastOutcome, safeCode: item.lastSafeCode,
    updatedAt: item.lastOccurredAt, raw: item });
}
export function eventIdentity(rowValue) {
  if (rowValue.key) return rowValue.key;
  return `${rowValue.source || ''}:${rowValue.shipmentId || ''}:${rowValue.jobId ?? ''}`;
}
export function appendUniqueRows(current, incoming) {
  const seen = new Set(current.map(eventIdentity));
  return [...current, ...incoming.filter(item => {
    const identity = eventIdentity(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  })];
}
export function filterLoadedRows(rows, { search = '', stage = '', outcome = '' }) {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter(item => (!query || [item.shipmentId, item.documentNumber, item.safeCode]
    .filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(query)))
    && (!stage || item.stage === stage) && (!outcome || item.outcome === outcome));
}

function ownFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return fields.reduce((result, field) => {
    const descriptor = descriptors[field];
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.enumerable) result[field] = descriptor.value;
    return result;
  }, {});
}
export function projectDiagnosticSnapshot(value) {
  const snapshot = ownFields(value, ['shipmentId', 'confirmedAt', 'branchCode', 'currency', 'paymentMode',
    'amountPaid', 'policyVersion', 'taxEligibility', 'bags', 'deliveryCharge']);
  if (snapshot.taxEligibility && typeof snapshot.taxEligibility === 'object') snapshot.taxEligibility = ownFields(snapshot.taxEligibility,
    ['governmentBorneVatEligible', 'reasonCode', 'evidenceReference', 'verifiedAt']);
  if (Array.isArray(snapshot.bags)) snapshot.bags = snapshot.bags.map(item => {
    const bag = ownFields(item, ['bagId', 'lineNumber', 'productCode', 'quantity', 'financialBreakup', 'prices']);
    if (bag.financialBreakup && typeof bag.financialBreakup === 'object') bag.financialBreakup = ownFields(bag.financialBreakup, ['price_effective', 'promotion_effective_discount',
      'coupon_effective_discount', 'value_of_good', 'gst_tax_percentage', 'gst_fee', 'amount_paid', 'delivery_charge']);
    if (bag.prices && typeof bag.prices === 'object') bag.prices = ownFields(bag.prices, ['promotion_effective_discount', 'coupon_effective_discount']);
    return bag;
  });
  if (snapshot.deliveryCharge && typeof snapshot.deliveryCharge === 'object') snapshot.deliveryCharge = ownFields(snapshot.deliveryCharge,
    ['taxCategory', 'taxRate', 'netAmount', 'taxAmount', 'paidAmount']);
  return snapshot;
}
export function canCopyPodCurl(value) {
  return value?.mode === 'dry-run' && value.job?.state === 'SUBMISSION_HELD'
    && value.steps?.fyndLock?.status === 'completed' && value.steps.fyndLock.result?.locked === true
    && value.steps?.oeisSubmission?.status === 'held';
}
function posixSingleQuote(value) { return `'${String(value).replace(/'/g, `\'"\'"\'`)}'`; }
export function buildPodCurl(envelope) {
  return [
    'curl --silent --show-error --max-redirs 0 \\', `  --request ${envelope.method} \\`,
    `  --url ${posixSingleQuote(envelope.url)} \\`,
    `  --header ${posixSingleQuote(`Authorization: APIkey ${envelope.apiKey}`)} \\`,
    `  --header ${posixSingleQuote('Connection: keep-alive')} \\`,
    `  --header ${posixSingleQuote('Content-Type: application/json')} \\`,
    `  --data-binary ${posixSingleQuote(envelope.requestJson)}`,
  ].join('\n');
}
