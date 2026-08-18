'use strict';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const MONGO_COLLECTION_NAMES = deepFreeze([
  'fdk_sessions',
  'webhook_events',
  'invoice_jobs',
  'invoice_artifacts',
  'invoice_outbox',
  'counters',
  'migration_markers',
  'shipment_audit_events',
  'shipment_audit_heads',
]);

const MONGO_INDEX_CATALOG = deepFreeze({
  fdk_sessions: [{
    name: 'fdk_sessions_expiresAt_ttl',
    key: { expiresAt: 1 },
    expireAfterSeconds: 0,
  }],
  webhook_events: [{
    name: 'webhook_events_companyId_eventId_uq',
    key: { companyId: 1, eventId: 1 },
    unique: true,
    collation: { locale: 'simple' },
  }],
  invoice_jobs: [
    { name: 'invoice_jobs_jobId_uq', key: { jobId: 1 }, unique: true },
    {
      name: 'invoice_jobs_companyId_shipmentId_documentType_uq',
      key: { companyId: 1, shipmentId: 1, documentType: 1 },
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      name: 'invoice_jobs_companyId_documentNumber_uq',
      key: { companyId: 1, documentNumber: 1 },
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      name: 'invoice_jobs_claim',
      key: { state: 1, dueAt: 1, leaseExpiresAt: 1, jobId: 1 },
      collation: { locale: 'simple' },
    },
    {
      name: 'invoice_jobs_companyId_state_jobId_list',
      key: { companyId: 1, state: 1, jobId: -1 },
      collation: { locale: 'simple' },
    },
  ],
  invoice_artifacts: [{
    name: 'invoice_artifacts_jobId_uq',
    key: { jobId: 1 },
    unique: true,
  }],
  invoice_outbox: [
    { name: 'invoice_outbox_outboxId_uq', key: { outboxId: 1 }, unique: true },
    {
      name: 'invoice_outbox_jobId_action_uq',
      key: { jobId: 1, action: 1 },
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      name: 'invoice_outbox_claim',
      key: { parentState: 1, status: 1, dueAt: 1, leaseExpiresAt: 1, outboxId: 1 },
      collation: { locale: 'simple' },
    },
  ],
  counters: [],
  migration_markers: [],
  shipment_audit_events: [
    {
      name: 'shipment_audit_events_eventKey_uq',
      key: { eventKey: 1 },
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_timeline',
      key: { companyId: 1, shipmentId: 1, occurredAt: -1, eventKey: -1 },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_recent',
      key: { companyId: 1, occurredAt: -1, _id: -1 },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_unresolved',
      key: { operationKey: 1, outcome: 1 },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_unresolved_target',
      key: {
        companyId: 1,
        jobId: 1,
        stage: 1,
        outcome: 1,
        occurredAt: -1,
        eventKey: -1,
      },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_pre_job_failure_repair',
      key: {
        jobId: 1,
        documentNumber: 1,
        outcome: 1,
        action: 1,
        _id: 1,
        expiresAt: 1,
      },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_events_expiresAt_ttl',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    },
  ],
  shipment_audit_heads: [
    {
      name: 'shipment_audit_heads_companyId_shipmentId_uq',
      key: { companyId: 1, shipmentId: 1 },
      unique: true,
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_heads_recent',
      key: { companyId: 1, lastOccurredAt: -1, shipmentId: -1 },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_heads_pre_job_failures',
      key: {
        companyId: 1,
        jobId: 1,
        documentNumber: 1,
        lastOutcome: 1,
        lastAction: 1,
        lastOccurredAt: -1,
        shipmentId: -1,
        expiresAt: 1,
      },
      collation: { locale: 'simple' },
    },
    {
      name: 'shipment_audit_heads_expiresAt_ttl',
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    },
  ],
});

function creationOptions(definition) {
  const options = { name: definition.name };
  for (const property of ['unique', 'expireAfterSeconds', 'collation']) {
    if (definition[property] !== undefined) options[property] = definition[property];
  }
  return options;
}

module.exports = {
  MONGO_COLLECTION_NAMES,
  MONGO_INDEX_CATALOG,
  creationOptions,
};
