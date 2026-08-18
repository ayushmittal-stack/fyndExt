'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { types } = require('util');

const { loadAppConfig, loadEinvoiceConfig } = require('./src/einvoice/config');
const { openMongoConnection } = require('./src/mongo/mongo-connection');
const { ManagedMongoStorage } = require('./src/fdk/managed-mongo-storage');
const {
  MONGO_TRANSACTION_TIMEOUT_MS,
  createMongoInvoiceRepository,
} = require('./src/einvoice/repositories/mongo-invoice-repository');
const {
  assertMongoInvoiceRepository,
} = require('./src/einvoice/repositories/invoice-repository');
const { createInvoiceRuntime } = require('./src/einvoice/runtime');
const { createFdkExtension } = require('./server');
const { createApp } = require('./src/app');

const PROCESS_WORKER_ID = `oeis-worker:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const RUNTIME_FIELDS = Object.freeze([
  'enabled', 'worker', 'repository', 'shipmentWebhookHandler', 'dryRunService',
  'shipmentActivityService',
]);
const WORKER_FIELDS = Object.freeze(['start', 'runOnce', 'stop']);
const DRY_RUN_FIELDS = Object.freeze([
  'listDryRuns', 'listDryRunFailures', 'getDryRunJourney', 'getDryRunRequest',
]);
const SHIPMENT_ACTIVITY_FIELDS = Object.freeze([
  'listShipments', 'listPreJobFailures', 'getTimeline',
]);
const PARTIAL_HTTP_SERVERS = new WeakMap();

function startupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactOwnDataSnapshot(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    return null;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length
        || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function ownDataValue(value, field) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')
      || types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function resolveCallableMethod(value, method) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    return null;
  }
  try {
    let current = value;
    while (current !== null) {
      if (types.isProxy(current)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) return null;
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function snapshotConnection(value) {
  const snapshot = exactOwnDataSnapshot(value, ['client', 'db', 'close']);
  if (!snapshot || snapshot.client === null || typeof snapshot.client !== 'object'
      || snapshot.db === null || typeof snapshot.db !== 'object'
      || typeof snapshot.close !== 'function' || types.isProxy(snapshot.close)) return null;
  return snapshot;
}

function snapshotWorker(value) {
  const snapshot = exactOwnDataSnapshot(value, WORKER_FIELDS);
  if (!snapshot || WORKER_FIELDS.some(field => (
    typeof snapshot[field] !== 'function' || types.isProxy(snapshot[field])
  ))) return null;
  return snapshot;
}

function validDryRunService(value) {
  const snapshot = exactOwnDataSnapshot(value, DRY_RUN_FIELDS);
  return snapshot !== null && DRY_RUN_FIELDS.every(field => (
    typeof snapshot[field] === 'function' && !types.isProxy(snapshot[field])
  ));
}

function validShipmentActivityService(value) {
  const snapshot = exactOwnDataSnapshot(value, SHIPMENT_ACTIVITY_FIELDS);
  return snapshot !== null && SHIPMENT_ACTIVITY_FIELDS.every(field => (
    typeof snapshot[field] === 'function' && !types.isProxy(snapshot[field])
  ));
}

function inspectRuntime(value) {
  const workerCandidate = ownDataValue(value, 'worker');
  const workerSnapshot = snapshotWorker(workerCandidate);
  const snapshot = exactOwnDataSnapshot(value, RUNTIME_FIELDS);
  if (!snapshot) return { snapshot: null, worker: workerSnapshot ? workerCandidate : null };
  return { snapshot, worker: workerSnapshot ? workerCandidate : null };
}

function closeCallbackResource(resource) {
  return new Promise((resolve, reject) => {
    if (resource === null || resource === undefined) return resolve();
    const close = resolveCallableMethod(resource, 'close');
    if (!close) return resolve();
    try {
      return Reflect.apply(close, resource, [error => (error ? reject(error) : resolve())]);
    } catch (error) {
      return reject(error);
    }
  });
}

function invokeResource(resource, method) {
  if (resource === null || resource === undefined) return Promise.resolve();
  const operation = resolveCallableMethod(resource, method);
  if (!operation) return Promise.resolve();
  try {
    return Promise.resolve(Reflect.apply(operation, resource, []));
  } catch (error) {
    return Promise.reject(error);
  }
}

function createShutdownCoordinator({ resources, logger, processObject = process } = {}) {
  if (!resources || typeof resources !== 'object' || types.isProxy(resources)
      || !logger || typeof logger !== 'object' || typeof logger.error !== 'function'
      || !processObject || typeof processObject !== 'object') {
    throw startupError('SHUTDOWN_CONFIG_INVALID', 'Shutdown configuration is invalid');
  }
  let shutdownPromise;

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    resources.shutdownRequested = true;
    shutdownPromise = (async () => {
      let failed = false;
      const attempt = async operation => {
        try {
          await operation();
        } catch {
          failed = true;
          try {
            logger.error('Shutdown cleanup failed', 'SHUTDOWN_CLEANUP_FAILED');
          } catch {
            // Cleanup and the original startup failure remain authoritative.
          }
        }
      };

      if (resources.startupSettled) await resources.startupSettled;
      await attempt(() => closeCallbackResource(resources.server));
      await attempt(() => invokeResource(resources.worker, 'stop'));
      await attempt(() => invokeResource(resources.repository, 'close'));
      await attempt(() => invokeResource(resources.storage, 'stop'));
      await attempt(() => invokeResource(resources.mongoConnection, 'close'));
      if (failed) processObject.exitCode = 1;
    })();
    return shutdownPromise;
  }

  return shutdown;
}

function registerSignalHandlers({ processObject = process, shutdown } = {}) {
  if (!processObject || typeof processObject.on !== 'function'
      || typeof processObject.removeListener !== 'function'
      || typeof shutdown !== 'function') {
    throw startupError('SHUTDOWN_CONFIG_INVALID', 'Shutdown configuration is invalid');
  }
  let removed = false;
  const onSignal = () => { shutdown(); };
  processObject.on('SIGINT', onSignal);
  processObject.on('SIGTERM', onSignal);
  return function removeSignalHandlers() {
    if (removed) return;
    removed = true;
    processObject.removeListener('SIGINT', onSignal);
    processObject.removeListener('SIGTERM', onSignal);
  };
}

function listenForRequests(app, port) {
  return new Promise((resolve, reject) => {
    let server;
    const onError = error => {
      if (server && ((typeof error === 'object' && error !== null) || typeof error === 'function')) {
        PARTIAL_HTTP_SERVERS.set(error, server);
      }
      reject(error);
    };
    try {
      server = app.listen(port, () => {
        if (server && typeof server.removeListener === 'function') {
          server.removeListener('error', onError);
        }
        resolve(server);
      });
      if (server && typeof server.once === 'function') server.once('error', onError);
    } catch (error) {
      reject(error);
    }
  });
}

function takePartialHttpServer(error) {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    const server = PARTIAL_HTTP_SERVERS.get(error);
    if (server !== undefined) {
      PARTIAL_HTTP_SERVERS.delete(error);
      return server;
    }
  }
  return ownDataValue(error, 'httpServer');
}

function parsePort(value) {
  const raw = value === undefined ? '8080' : String(value);
  if (!/^\d+$/.test(raw)) throw startupError('PORT_INVALID', 'Backend port is invalid');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw startupError('PORT_INVALID', 'Backend port is invalid');
  }
  return port;
}

function readApplicationMongoConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || types.isProxy(config)) {
    throw startupError('APPLICATION_CONFIG_INVALID', 'Application configuration is invalid');
  }
  const mongoConfig = ownDataValue(config, 'mongoConfig');
  if (mongoConfig === undefined) {
    throw startupError('APPLICATION_CONFIG_INVALID', 'Application configuration is invalid');
  }
  return mongoConfig;
}

function readInvoiceMode(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config) || types.isProxy(config)) {
    throw startupError('INVOICE_CONFIG_INVALID', 'Invoice configuration is invalid');
  }
  const enabled = ownDataValue(config, 'enabled');
  if (typeof enabled !== 'boolean') {
    throw startupError('INVOICE_CONFIG_INVALID', 'Invoice configuration is invalid');
  }
  if (enabled) {
    const leaseMs = ownDataValue(config, 'jobLeaseMs');
    if (!Number.isSafeInteger(leaseMs)
        || leaseMs <= MONGO_TRANSACTION_TIMEOUT_MS || leaseMs > 3_600_000) {
      throw startupError('CONFIG_INTEGER_INVALID', 'Configuration is out of range: EINVOICE_JOB_LEASE_MS');
    }
  }
  return enabled;
}

async function main(deps = {}) {
  const {
    env = process.env,
    processObject = process,
    logger = console,
    loadDotenv = () => require('dotenv').config(),
    loadApplicationConfig = loadAppConfig,
    loadInvoiceConfig = loadEinvoiceConfig,
    openMongo = openMongoConnection,
    createManagedStorage = db => new ManagedMongoStorage(db),
    createInvoiceRepository = ({ db, client }) => createMongoInvoiceRepository({ db, client }),
    createRuntime = createInvoiceRuntime,
    createFdk = createFdkExtension,
    createApplication = createApp,
    listen = listenForRequests,
    staticPath = env.NODE_ENV === 'production'
      ? path.join(process.cwd(), 'frontend', 'public', 'dist')
      : path.join(process.cwd(), 'frontend'),
    workerId = PROCESS_WORKER_ID,
  } = deps;
  const resources = {
    server: null,
    worker: null,
    repository: null,
    storage: null,
    mongoConnection: null,
    shutdownRequested: false,
  };
  let settleStartup;
  let startupIsSettled = false;
  resources.startupSettled = new Promise(resolve => { settleStartup = resolve; });
  const markStartupSettled = () => {
    if (startupIsSettled) return;
    startupIsSettled = true;
    settleStartup();
  };
  const ensureStartupActive = () => {
    if (resources.shutdownRequested) {
      throw startupError('STARTUP_ABORTED', 'Application startup was interrupted');
    }
  };
  const coordinateShutdown = createShutdownCoordinator({ resources, logger, processObject });
  let removeSignalHandlers = () => {};
  const shutdown = () => {
    const result = coordinateShutdown();
    result.finally(removeSignalHandlers);
    return result;
  };
  removeSignalHandlers = registerSignalHandlers({ processObject, shutdown });

  try {
    loadDotenv();
    const applicationConfig = loadApplicationConfig(env);
    const invoiceConfig = loadInvoiceConfig(env);
    const mongoConfig = readApplicationMongoConfig(applicationConfig);
    const invoiceEnabled = readInvoiceMode(invoiceConfig);
    const port = parsePort(env.BACKEND_PORT);
    ensureStartupActive();

    const openedConnection = await openMongo({ config: mongoConfig });
    resources.mongoConnection = openedConnection;
    const connectionSnapshot = snapshotConnection(openedConnection);
    if (!connectionSnapshot) {
      throw startupError('MONGO_CONNECTION_INVALID', 'Mongo connection is invalid');
    }
    ensureStartupActive();

    const storage = createManagedStorage(connectionSnapshot.db);
    const initializeStorage = resolveCallableMethod(storage, 'initialize');
    const stopStorage = resolveCallableMethod(storage, 'stop');
    if (!initializeStorage || !stopStorage) {
      throw startupError('SESSION_STORAGE_INVALID', 'Session storage is invalid');
    }
    resources.storage = storage;
    ensureStartupActive();
    await Reflect.apply(initializeStorage, storage, []);
    ensureStartupActive();

    let repository = null;
    if (invoiceEnabled) {
      repository = createInvoiceRepository({
        db: connectionSnapshot.db,
        client: connectionSnapshot.client,
      });
      resources.repository = repository;
      assertMongoInvoiceRepository(repository);
      ensureStartupActive();
      await repository.initialize();
      ensureStartupActive();
    }

    let fdkExtension;
    const getPlatformClient = async companyId => {
      const getClient = resolveCallableMethod(fdkExtension, 'getPlatformClient');
      if (!getClient) {
        throw startupError('FDK_CLIENT_UNAVAILABLE', 'FDK platform client is unavailable');
      }
      return Reflect.apply(getClient, fdkExtension, [companyId]);
    };
    const runtime = await createRuntime({
      env,
      repository,
      workerId,
      logger,
      getPlatformClient,
      loadConfig: () => invoiceConfig,
    });
    const runtimeInspection = inspectRuntime(runtime);
    if (runtimeInspection.worker !== null) resources.worker = runtimeInspection.worker;
    const runtimeResult = runtimeInspection.snapshot;
    const runtimeIsConsistent = runtimeResult
      && typeof runtimeResult.enabled === 'boolean'
      && runtimeResult.enabled === invoiceEnabled
      && runtimeResult.repository === repository
      && typeof runtimeResult.shipmentWebhookHandler === 'function'
      && !types.isProxy(runtimeResult.shipmentWebhookHandler)
      && runtimeInspection.worker !== null
      && ((invoiceEnabled && runtimeResult.dryRunService !== null
        && validDryRunService(runtimeResult.dryRunService)
        && runtimeResult.shipmentActivityService !== null
        && validShipmentActivityService(runtimeResult.shipmentActivityService))
        || (!invoiceEnabled && runtimeResult.dryRunService === null
          && runtimeResult.shipmentActivityService === null));
    if (!runtimeIsConsistent) {
      throw startupError('INVOICE_RUNTIME_INVALID', 'Invoice runtime is invalid');
    }
    ensureStartupActive();

    fdkExtension = await createFdk({
      env,
      storage: resources.storage,
      shipmentWebhookHandler: runtimeResult.shipmentWebhookHandler,
    });
    ensureStartupActive();
    const app = createApplication({
      fdkExtension,
      logger,
      staticPath,
      dryRunService: runtimeResult.dryRunService,
      shipmentActivityService: runtimeResult.shipmentActivityService,
    });
    ensureStartupActive();
    resources.server = await listen(app, port);
    if (!resolveCallableMethod(resources.server, 'close')) {
      throw startupError('HTTP_SERVER_INVALID', 'HTTP server is invalid');
    }
    ensureStartupActive();
    const startWorker = snapshotWorker(resources.worker).start;
    await Reflect.apply(startWorker, resources.worker, []);
    ensureStartupActive();
    markStartupSettled();
    return Object.freeze({
      app,
      server: resources.server,
      worker: resources.worker,
      repository: resources.repository,
      storage: resources.storage,
      mongoConnection: resources.mongoConnection,
      shutdown,
      removeSignalHandlers,
    });
  } catch (primaryError) {
    const attachedServer = takePartialHttpServer(primaryError);
    if (attachedServer !== undefined) resources.server = attachedServer;
    processObject.exitCode = 1;
    markStartupSettled();
    await coordinateShutdown();
    removeSignalHandlers();
    throw primaryError;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Application startup failed', 'APPLICATION_STARTUP_FAILED');
    process.exitCode = 1;
  });
}

module.exports = {
  PROCESS_WORKER_ID,
  createShutdownCoordinator,
  registerSignalHandlers,
  listenForRequests,
  main,
};
