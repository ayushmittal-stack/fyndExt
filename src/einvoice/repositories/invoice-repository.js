'use strict';

const { types } = require('util');

const { EinvoiceError } = require('../errors');

const JOB_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  DRY_RUN_RECEIVED: 'DRY_RUN_RECEIVED',
  LOCK_PENDING: 'LOCK_PENDING',
  DRY_RUN_LOCK_PENDING: 'DRY_RUN_LOCK_PENDING',
  LOCKED: 'LOCKED',
  FYND_TRANSITION_PENDING: 'FYND_TRANSITION_PENDING',
  COMPLETED: 'COMPLETED',
  RETRY_WAIT: 'RETRY_WAIT',
  DRY_RUN_RETRY_WAIT: 'DRY_RUN_RETRY_WAIT',
  SUBMISSION_HELD: 'SUBMISSION_HELD',
  DATA_FAILED: 'DATA_FAILED',
  INDETERMINATE: 'INDETERMINATE',
});

const OUTBOX_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  RETRY_WAIT: 'RETRY_WAIT',
  COMPLETED: 'COMPLETED',
  INDETERMINATE: 'INDETERMINATE',
});

const OUTBOX_ACTIONS = Object.freeze({
  FYND_TRANSITION: 'FYND_TRANSITION',
});

const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  'initialize',
  'acceptWebhook',
  'claimNextJob',
  'savePreparedRequest',
  'markShipmentLocked',
  'markOeisAcceptedAndEnqueue',
  'scheduleJobRetry',
  'markJobFailed',
  'markJobIndeterminate',
  'claimNextOutbox',
  'scheduleOutboxRetry',
  'markOutboxIndeterminate',
  'completeOutboxAndJob',
  'releaseExpiredLeases',
  'getJob',
  'getArtifact',
  'close',
]);

const MONGO_REPOSITORY_METHODS = Object.freeze([
  'listDryRunJobsForCompany',
  'listFailedJobsForCompany',
  'getDryRunJobForCompany',
  'getDryRunRequestForCompany',
  'appendAuditEvents',
  'beginExternalOperation',
  'findUnresolvedAuditOperation',
  'listShipmentAuditHeadsForCompany',
  'listPreJobFailureHeadsForCompany',
  'listShipmentAuditEventsForCompany',
  'importHeldOeisResponseAndEnqueue',
]);

function assertInvoiceRepository(repository) {
  if (!repository || typeof repository !== 'object'
      || REQUIRED_REPOSITORY_METHODS.some(method => typeof repository[method] !== 'function')) {
    throw new EinvoiceError('REPOSITORY_PORT_INVALID', 'Invoice repository does not implement the required interface');
  }
  return repository;
}

function assertMongoInvoiceRepository(repository) {
  const methods = [...REQUIRED_REPOSITORY_METHODS, ...MONGO_REPOSITORY_METHODS];
  let valid = repository !== null && typeof repository === 'object' && !types.isProxy(repository);
  if (valid) {
    try {
      valid = Object.getPrototypeOf(repository) === Object.prototype;
      const keys = Reflect.ownKeys(repository);
      valid = valid && keys.length === methods.length
        && keys.every(key => typeof key === 'string' && methods.includes(key));
      for (const method of valid ? methods : []) {
        const descriptor = Object.getOwnPropertyDescriptor(repository, method);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) {
          valid = false;
          break;
        }
      }
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new EinvoiceError(
      'REPOSITORY_PORT_INVALID',
      'Invoice repository does not implement the required interface',
    );
  }
  return repository;
}

module.exports = {
  JOB_STATES,
  MONGO_REPOSITORY_METHODS,
  OUTBOX_ACTIONS,
  OUTBOX_STATUSES,
  REQUIRED_REPOSITORY_METHODS,
  assertInvoiceRepository,
  assertMongoInvoiceRepository,
};
