'use strict';

const { types } = require('node:util');
const { EinvoiceError } = require('../errors');
const {
  createAuditBundle,
  createEventKey,
} = require('../audit/audit-contract');
const {
  extractTrustedShipmentIdentity,
  normalizeShipmentWebhook,
} = require('../snapshot-normalizer');
const { POLICY_VERSION } = require('../tax-policy-resolver');

const LOG_SAFE_CODES = new Set([
  'WEBHOOK_EVENT_UNSUPPORTED',
  'WEBHOOK_PAYLOAD_INVALID',
  'WEBHOOK_EVENT_ID_REQUIRED',
  'WEBHOOK_EVENT_ID_INVALID',
  'WEBHOOK_IDENTIFIER_INVALID',
  'WEBHOOK_IDENTIFIER_CONFLICT',
  'SHIPMENT_STATUS_CONFLICT',
  'SHIPMENT_STATUS_REQUIRED',
  'SHIPMENT_CONFIRMED_AT_REQUIRED',
  'SHIPMENT_BRANCH_REQUIRED',
  'SHIPMENT_AMOUNT_PAID_REQUIRED',
  'SHIPMENT_AMOUNT_PAID_INVALID',
  'SHIPMENT_BAGS_REQUIRED',
  'SHIPMENT_BAG_INVALID',
  'SHIPMENT_QUANTITY_INVALID',
  'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
  'SHIPMENT_FINANCIAL_VALUE_INVALID',
  'SHIPMENT_DISCOUNT_INVALID',
  'SHIPMENT_DISCOUNT_CONFLICT',
  'SHIPMENT_PRICE_INVALID',
  'SHIPMENT_PRICES_INVALID',
  'SHIPMENT_TAX_RATE_INVALID',
  'SHIPMENT_PRODUCT_TYPE_INVALID',
  'PAYMENT_MODE_INVALID',
  'PAYMENT_MODE_UNSUPPORTED',
  'CURRENCY_UNSUPPORTED',
  'REPOSITORY_BUSY',
  'REPOSITORY_UNAVAILABLE',
  'REPOSITORY_VERSION_CONFLICT',
  'REPOSITORY_TRANSACTION_UNKNOWN',
  'REPOSITORY_DATA_INVALID',
  'REPOSITORY_INPUT_INVALID',
  'IDEMPOTENCY_CONFLICT',
  'WEBHOOK_CLOCK_INVALID',
  'WEBHOOK_STORAGE_RESULT_INVALID',
  'AUDIT_CLOCK_INVALID',
  'AUDIT_INPUT_INVALID',
]);

const VALIDATION_SAFE_CODES = new Set([
  'SHIPMENT_STATUS_REQUIRED',
  'SHIPMENT_BRANCH_REQUIRED',
  'SHIPMENT_AMOUNT_PAID_REQUIRED',
  'SHIPMENT_AMOUNT_PAID_INVALID',
  'SHIPMENT_BAGS_REQUIRED',
  'SHIPMENT_BAG_INVALID',
  'SHIPMENT_QUANTITY_INVALID',
  'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
  'SHIPMENT_FINANCIAL_VALUE_INVALID',
  'SHIPMENT_DISCOUNT_INVALID',
  'SHIPMENT_DISCOUNT_CONFLICT',
  'SHIPMENT_PRICE_INVALID',
  'SHIPMENT_PRICES_INVALID',
  'SHIPMENT_TAX_RATE_INVALID',
  'SHIPMENT_PRODUCT_TYPE_INVALID',
  'SHIPMENT_DELIVERY_CHARGE_REQUIRED',
  'SHIPMENT_DELIVERY_TAX_RATE_INVALID',
  'SHIPMENT_DELIVERY_TOTAL_MISMATCH',
  'SHIPMENT_DELIVERY_VALUE_INVALID',
  'PAYMENT_MODE_INVALID',
  'PAYMENT_MODE_UNSUPPORTED',
  'CURRENCY_UNSUPPORTED',
  'TAX_ELIGIBILITY_POLICY_INVALID',
]);

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isObject(value)) return false;
  try {
    return !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasOwnData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  } catch {
    return false;
  }
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return { found: false, value: undefined };
  }
  return { found: true, value: descriptor.value };
}

function ownCallable(value, key) {
  if (!isObject(value) || types.isProxy(value)) return null;
  try {
    const field = ownDataValue(value, key);
    return field.found && typeof field.value === 'function' && !types.isProxy(field.value)
      ? field.value
      : null;
  } catch {
    return null;
  }
}

function validAcceptedResult(accepted) {
  try {
    return isPlainRecord(accepted)
      && Reflect.ownKeys(accepted).length === 2
      && Reflect.ownKeys(accepted).every(key => key === 'created' || key === 'jobId')
      && hasOwnData(accepted, 'created')
      && hasOwnData(accepted, 'jobId')
      && typeof accepted.created === 'boolean'
      && Number.isSafeInteger(accepted.jobId)
      && accepted.jobId > 0;
  } catch {
    return false;
  }
}

function readClock(now) {
  let value;
  try {
    value = now();
  } catch {
    fail('WEBHOOK_CLOCK_INVALID', 'Shipment webhook clock is invalid');
  }
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Date.prototype
        || Reflect.ownKeys(value).length !== 0
        || !Number.isFinite(Date.prototype.getTime.call(value))) {
      fail('WEBHOOK_CLOCK_INVALID', 'Shipment webhook clock is invalid');
    }
    return new Date(Date.prototype.getTime.call(value));
  } catch (error) {
    if (error instanceof EinvoiceError) throw error;
    fail('WEBHOOK_CLOCK_INVALID', 'Shipment webhook clock is invalid');
  }
}

function eventInput(identity, {
  stage,
  action,
  outcome,
  startedAt = null,
  completedAt = null,
  safeCode: eventSafeCode = null,
}) {
  const eventKey = action === 'WEBHOOK_RECEIVED'
    ? createEventKey({
      kind: 'WEBHOOK_RECEIPT',
      companyId: identity.companyId,
      eventId: identity.eventId,
    })
    : createEventKey({
      kind: 'ENTITY',
      companyId: identity.companyId,
      shipmentId: identity.shipmentId,
      scopeKind: 'WEBHOOK',
      scopeId: identity.eventId,
      parentVersion: 0,
      attemptNumber: 0,
      stage,
      action,
      outcome,
    });
  return {
    eventKey,
    operationKey: null,
    companyId: identity.companyId,
    applicationId: identity.applicationId,
    shipmentId: identity.shipmentId,
    jobId: null,
    documentNumber: null,
    stage,
    action,
    outcome,
    attemptNumber: 0,
    startedAt,
    completedAt,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: eventSafeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  };
}

function timedBundle(inputs, now) {
  const occurredAt = readClock(now);
  return createAuditBundle(inputs, { now: () => new Date(occurredAt.getTime()) });
}

function validationSafeCode(error) {
  return error instanceof EinvoiceError && VALIDATION_SAFE_CODES.has(error.code)
    ? error.code
    : 'WEBHOOK_VALIDATION_FAILED';
}

function safeCode(error) {
  return error instanceof EinvoiceError && LOG_SAFE_CODES.has(error.code)
    ? error.code
    : 'WEBHOOK_PROCESSING_FAILED';
}

function createShipmentWebhookHandler(options = {}) {
  let enabled;
  let dryRunEnabled;
  let valid = false;
  try {
    valid = isPlainRecord(options);
    const enabledField = valid ? ownDataValue(options, 'enabled') : { found: false };
    enabled = enabledField.value;
    valid = valid && enabledField.found && typeof enabled === 'boolean';
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WEBHOOK_CONFIG_INVALID', 'Shipment webhook configuration is invalid');
  }
  if (enabled === false) {
    return async function disabledShipmentWebhookHandler() {
      return { acknowledged: true, ignored: 'disabled' };
    };
  }

  try {
    const dryRunField = ownDataValue(options, 'dryRunEnabled');
    dryRunEnabled = dryRunField.value;
    valid = dryRunField.found && typeof dryRunEnabled === 'boolean';
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WEBHOOK_CONFIG_INVALID', 'Shipment webhook configuration is invalid');
  }

  let repository;
  let logger;
  let now;
  let policyVersion;
  valid = false;
  try {
    const repositoryField = ownDataValue(options, 'repository');
    const loggerField = ownDataValue(options, 'logger');
    const nowField = ownDataValue(options, 'now');
    const policyField = ownDataValue(options, 'policyVersion');
    repository = repositoryField.value;
    logger = loggerField.value;
    now = nowField.value;
    policyVersion = policyField.found ? policyField.value : POLICY_VERSION;
    const acceptWebhook = ownCallable(repository, 'acceptWebhook');
    const appendAuditEvents = ownCallable(repository, 'appendAuditEvents');
    const logError = ownCallable(logger, 'error');
    valid = repositoryField.found && loggerField.found && nowField.found
      && acceptWebhook !== null && appendAuditEvents !== null && logError !== null
      && typeof now === 'function' && !types.isProxy(now)
      && policyVersion === POLICY_VERSION;
    if (valid) {
      repository = Object.freeze({ acceptWebhook, appendAuditEvents });
      logger = Object.freeze({ error: logError });
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WEBHOOK_CONFIG_INVALID', 'Shipment webhook configuration is invalid');
  }

  return async function shipmentWebhookHandler(eventName, body, companyId, applicationId) {
    try {
      const trustedIdentity = extractTrustedShipmentIdentity({
        eventName, body, companyId, applicationId,
      });
      const receipt = timedBundle([eventInput(trustedIdentity, {
        stage: 'WEBHOOK',
        action: 'WEBHOOK_RECEIVED',
        outcome: 'SUCCESS',
      })], now);
      await repository.appendAuditEvents(receipt);

      const validationStarted = timedBundle([eventInput(trustedIdentity, {
        stage: 'VALIDATION',
        action: 'VALIDATION_STARTED',
        outcome: 'STARTED',
      })], now);
      await repository.appendAuditEvents(validationStarted);
      const validationStartedAt = new Date(validationStarted[0].startedAt);

      let normalized;
      try {
        normalized = normalizeShipmentWebhook({ trustedIdentity, policyVersion });
      } catch (error) {
        const code = validationSafeCode(error);
        const completedAt = readClock(now);
        const rejected = createAuditBundle([
          eventInput(trustedIdentity, {
            stage: 'VALIDATION',
            action: 'VALIDATION_FAILED',
            outcome: 'FAILURE',
            startedAt: validationStartedAt,
            completedAt,
            safeCode: code,
          }),
          eventInput(trustedIdentity, {
            stage: 'WEBHOOK',
            action: 'WEBHOOK_REJECTED',
            outcome: 'FAILURE',
            startedAt: validationStartedAt,
            completedAt,
            safeCode: code,
          }),
        ], { now: () => new Date(completedAt.getTime()) });
        await repository.appendAuditEvents(rejected);
        throw error;
      }

      const completedAt = readClock(now);
      if (normalized.ignored === true) {
        const ignored = createAuditBundle([eventInput(trustedIdentity, {
          stage: 'WEBHOOK',
          action: 'WEBHOOK_IGNORED',
          outcome: 'SUCCESS',
          startedAt: validationStartedAt,
          completedAt,
        })], { now: () => new Date(completedAt.getTime()) });
        await repository.appendAuditEvents(ignored);
        return { acknowledged: true, ignored: 'status' };
      }

      const validationPassed = createAuditBundle([eventInput(trustedIdentity, {
        stage: 'VALIDATION',
        action: 'VALIDATION_PASSED',
        outcome: 'SUCCESS',
        startedAt: validationStartedAt,
        completedAt,
      })], { now: () => new Date(completedAt.getTime()) });
      const receivedAt = new Date(receipt[0].occurredAt);
      const accepted = await repository.acceptWebhook(
        { ...normalized.eventRecord, receivedAt },
        normalized.shipment,
        dryRunEnabled,
        validationPassed,
      );
      if (!validAcceptedResult(accepted)) {
        fail('WEBHOOK_STORAGE_RESULT_INVALID', 'Shipment webhook storage result is invalid');
      }
      return { acknowledged: true, created: accepted.created, jobId: accepted.jobId };
    } catch (error) {
      logger.error('Shipment webhook processing failed', safeCode(error));
      throw error;
    }
  };
}

module.exports = { createShipmentWebhookHandler };
