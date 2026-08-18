'use strict';

const axios = require('axios');
const { types } = require('util');
const { loadEinvoiceConfig } = require('./config');
const { loadMasterData } = require('./master-data-gateway');
const { assertMongoInvoiceRepository } = require('./repositories/invoice-repository');
const { createOeisClient, OEIS_UPDATE_PATH } = require('./clients/oeis-client');
const { createFyndShipmentClient } = require('./clients/fynd-shipment-client');
const { buildOeisPayload } = require('./payload-builder');
const { POLICY_VERSION, createTaxPolicyResolver } = require('./tax-policy-resolver');
const { parseOeisB2cResponse } = require('./response-parser');
const { createInvoiceWorkflow } = require('./invoice-workflow');
const { createInvoiceWorker } = require('./invoice-worker');
const { createShipmentWebhookHandler } = require('./webhooks/shipment-webhook');
const { createDryRunService } = require('./dry-run-service');
const { createShipmentActivityService } = require('./shipment-activity-service');
const { EinvoiceError } = require('./errors');

const NOOP_WORKER = Object.freeze({
  async start() {},
  async runOnce() {},
  async stop() {},
});
const WORKER_METHODS = Object.freeze(['start', 'runOnce', 'stop']);

async function disabledWebhookHandler() {
  return { acknowledged: true, ignored: 'disabled' };
}

function runtimeConfigError() {
  return new EinvoiceError('RUNTIME_CONFIG_INVALID', 'Invoice runtime configuration is invalid');
}

function validLogger(logger) {
  return logger && typeof logger === 'object' && typeof logger.error === 'function';
}

function validTaxPolicyResolver(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'resolveLineTax');
    return descriptor !== undefined
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && typeof descriptor.value === 'function';
  } catch {
    return false;
  }
}

function validWorker(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== WORKER_METHODS.length
        || keys.some(key => typeof key !== 'string' || !WORKER_METHODS.includes(key))) {
      return false;
    }
    return WORKER_METHODS.every(method => {
      const descriptor = Object.getOwnPropertyDescriptor(value, method);
      return descriptor !== undefined
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.value === 'function'
        && !types.isProxy(descriptor.value);
    });
  } catch {
    return false;
  }
}

function snapshotDryRunService(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      throw runtimeConfigError();
    }
    const snapshot = {};
    for (const field of ['listDryRuns', 'listDryRunFailures', 'getDryRunJourney', 'getDryRunRequest']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function') {
        throw runtimeConfigError();
      }
      snapshot[field] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw runtimeConfigError();
  }
}

function snapshotShipmentActivityService(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw runtimeConfigError();
    }
    const fields = ['listShipments', 'listPreJobFailures', 'getTimeline'];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length
        || keys.some((key, index) => key !== fields[index])) throw runtimeConfigError();
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) {
        throw runtimeConfigError();
      }
      snapshot[field] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw runtimeConfigError();
  }
}

async function createInvoiceRuntime(deps = {}) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps) || types.isProxy(deps)) {
    throw runtimeConfigError();
  }
  const {
    env = process.env,
    loadConfig = loadEinvoiceConfig,
    repository,
  } = deps;
  if (typeof loadConfig !== 'function') throw runtimeConfigError();
  const config = loadConfig(env);
  if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean') {
    throw runtimeConfigError();
  }
  if (!config.enabled) {
    if (repository !== null) throw runtimeConfigError();
    return Object.freeze({
      enabled: false,
      shipmentWebhookHandler: disabledWebhookHandler,
      worker: NOOP_WORKER,
      repository: null,
      dryRunService: null,
      shipmentActivityService: null,
    });
  }

  const {
    workerId,
    logger,
    now = () => new Date(),
    getPlatformClient,
    loadMaster = loadMasterData,
    axiosLibrary = axios,
    createOeis = createOeisClient,
    createFynd = createFyndShipmentClient,
    createTaxResolver = createTaxPolicyResolver,
    buildPayload = buildOeisPayload,
    parseResponse = parseOeisB2cResponse,
    createWorkflow = createInvoiceWorkflow,
    createWorker = createInvoiceWorker,
    createWebhookHandler = createShipmentWebhookHandler,
    createDryRun = createDryRunService,
    createShipmentActivity = createShipmentActivityService,
  } = deps;
  if (typeof workerId !== 'string' || workerId.trim() === ''
      || !validLogger(logger) || typeof now !== 'function'
      || typeof getPlatformClient !== 'function'
      || typeof loadMaster !== 'function'
      || !axiosLibrary || typeof axiosLibrary.create !== 'function'
      || typeof createOeis !== 'function' || typeof createFynd !== 'function'
      || typeof createTaxResolver !== 'function'
      || typeof buildPayload !== 'function' || typeof parseResponse !== 'function'
      || typeof createWorkflow !== 'function' || typeof createWorker !== 'function'
      || typeof createWebhookHandler !== 'function' || typeof createDryRun !== 'function'
      || typeof createShipmentActivity !== 'function') {
    throw runtimeConfigError();
  }

  try {
    assertMongoInvoiceRepository(repository);
  } catch {
    throw runtimeConfigError();
  }
  const masterData = loadMaster({ filePath: config.masterDataPath });
  const taxPolicyResolver = createTaxResolver({ policyVersion: POLICY_VERSION, now });
  if (!validTaxPolicyResolver(taxPolicyResolver)) {
    throw runtimeConfigError();
  }
  const axiosInstance = axiosLibrary.create();
  const dryRunService = snapshotDryRunService(createDryRun({
    repository,
    oeisBaseUrl: config.baseUrl,
    maxRequestBytes: config.maxRequestBytes,
  }));
  const shipmentActivityService = snapshotShipmentActivityService(createShipmentActivity({
    repository,
    now,
  }));
  const oeisClient = createOeis({
    axiosInstance,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    maxRequestBytes: config.maxRequestBytes,
    maxResponseBytes: config.maxResponseBytes,
  });
  const fyndClient = createFynd({ getPlatformClient });
  const boundPayloadBuilder = snapshot => buildPayload(snapshot, {
    companyCode: config.companyCode,
    sourceErp: config.sourceErp,
    supplierCountryCode: config.supplierCountryCode,
    amountTolerance: config.amountTolerance,
    masterData,
    taxPolicyResolver,
  });
  const workflow = createWorkflow({
    repository,
    buildPayload: boundPayloadBuilder,
    oeisClient,
    parseResponse,
    fyndClient,
    now,
    oeisAudit: {
      endpointPath: OEIS_UPDATE_PATH,
      timeoutMs: config.timeoutMs,
    },
  });
  const worker = createWorker({
    repository,
    workflow,
    workerId,
    pollMs: config.workerPollMs,
    leaseMs: config.jobLeaseMs,
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
    logger,
    now,
    policyVersion: POLICY_VERSION,
  });
  const shipmentWebhookHandler = createWebhookHandler({
    enabled: true,
    dryRunEnabled: config.dryRunEnabled,
    repository,
    logger,
    now,
  });
  if (!validWorker(worker) || typeof shipmentWebhookHandler !== 'function'
      || types.isProxy(shipmentWebhookHandler)) {
    throw runtimeConfigError();
  }
  return Object.freeze({
    enabled: true,
    shipmentWebhookHandler,
    worker,
    repository,
    dryRunService,
    shipmentActivityService,
  });
}

module.exports = { createInvoiceRuntime };
