'use strict';

const { EventEmitter } = require('events');

const REPOSITORY_METHODS = Object.freeze([
  'initialize', 'acceptWebhook', 'claimNextJob', 'savePreparedRequest',
  'markShipmentLocked', 'markOeisAcceptedAndEnqueue', 'scheduleJobRetry',
  'markJobFailed', 'markJobIndeterminate', 'claimNextOutbox',
  'scheduleOutboxRetry', 'markOutboxIndeterminate', 'completeOutboxAndJob',
  'releaseExpiredLeases', 'getJob', 'getArtifact', 'close',
  'listDryRunJobsForCompany', 'listFailedJobsForCompany',
  'getDryRunJobForCompany', 'getDryRunRequestForCompany', 'appendAuditEvents',
  'beginExternalOperation', 'findUnresolvedAuditOperation',
  'listShipmentAuditHeadsForCompany', 'listPreJobFailureHeadsForCompany',
  'listShipmentAuditEventsForCompany',
  'importHeldOeisResponseAndEnqueue',
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitForCall(mock) {
  for (let attempt = 0; attempt < 100 && mock.mock.calls.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(mock).toHaveBeenCalled();
}

function appConfig() {
  return {
    extensionApiKey: 'key',
    extensionApiSecret: 'synthetic-secret',
    extensionBaseUrl: 'https://extension.example.test',
    fpApiDomain: 'https://api.example.test',
    webhookNotificationEmail: 'ops@example.test',
    mongoConfig: Object.freeze({
      uri: 'mongodb+srv://user:synthetic-secret@cluster.example/?appName=SGH',
      dbName: 'sgh_oeis_einvoicing',
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    }),
  };
}

function invoiceConfig(enabled = true) {
  return enabled ? { enabled: true, jobLeaseMs: 5001 } : { enabled: false };
}

function repositorySurface(order) {
  const repository = Object.fromEntries(REPOSITORY_METHODS.map(method => [method, jest.fn()]));
  repository.initialize.mockImplementation(async () => { order.push('repository.initialize'); });
  repository.close.mockImplementation(async () => { order.push('repository.close'); });
  return repository;
}

function harness(overrides = {}) {
  const order = [];
  const processObject = new EventEmitter();
  processObject.exitCode = undefined;
  const client = {
    marker: 'shared-client',
    close: jest.fn(async () => { order.push('client.close'); }),
  };
  const db = { marker: 'shared-db' };
  const mongoConnection = {
    client,
    db,
    close: jest.fn(async () => {
      order.push('mongo.close');
      await client.close();
    }),
  };
  const storage = {
    initialize: jest.fn(async () => { order.push('storage.initialize'); }),
    stop: jest.fn(async () => { order.push('storage.stop'); }),
  };
  const repository = repositorySurface(order);
  const worker = {
    start: jest.fn(async () => { order.push('worker.start'); }),
    runOnce: jest.fn(async () => undefined),
    stop: jest.fn(async () => { order.push('worker.stop'); }),
  };
  const fdkExtension = { getPlatformClient: jest.fn(), marker: 'fdk' };
  const dryRunService = {
    listDryRuns: jest.fn(),
    listDryRunFailures: jest.fn(),
    getDryRunJourney: jest.fn(),
    getDryRunRequest: jest.fn(),
    getDryRunPodCurl: jest.fn(),
  };
  const shipmentActivityService = {
    listShipments: jest.fn(),
    listPreJobFailures: jest.fn(),
    getTimeline: jest.fn(),
  };
  const app = { marker: 'app' };
  const httpServer = {
    close: jest.fn(callback => { order.push('server.close'); callback(null); }),
  };
  let lazyPlatformClient;
  let preFdkPlatformResult;
  const applicationConfig = appConfig();
  const einvoiceConfig = invoiceConfig(true);
  const deps = {
    env: { BACKEND_PORT: '9090' },
    processObject,
    logger: { error: jest.fn() },
    loadDotenv: jest.fn(() => { order.push('dotenv'); }),
    loadApplicationConfig: jest.fn(() => {
      order.push('app.config');
      return applicationConfig;
    }),
    loadInvoiceConfig: jest.fn(() => {
      order.push('invoice.config');
      return einvoiceConfig;
    }),
    openMongo: jest.fn(async () => { order.push('mongo.open'); return mongoConnection; }),
    createManagedStorage: jest.fn(receivedDb => {
      order.push('storage.construct');
      expect(receivedDb).toBe(db);
      return storage;
    }),
    createInvoiceRepository: jest.fn(input => {
      order.push('repository.construct');
      expect(input).toEqual({ db, client });
      expect(input.db).toBe(db);
      expect(input.client).toBe(client);
      return repository;
    }),
    createRuntime: jest.fn(async options => {
      order.push('runtime');
      lazyPlatformClient = options.getPlatformClient;
      preFdkPlatformResult = options.getPlatformClient('before-fdk').catch(error => error);
      return {
        enabled: true,
        repository,
        worker,
        shipmentWebhookHandler: jest.fn(),
        dryRunService,
        shipmentActivityService,
      };
    }),
    createFdk: jest.fn(async () => { order.push('fdk'); return fdkExtension; }),
    createApplication: jest.fn(() => { order.push('app'); return app; }),
    listen: jest.fn(async () => { order.push('listen'); return httpServer; }),
    staticPath: '/static',
    workerId: 'stable-process-worker-id',
    ...overrides,
  };
  return {
    deps,
    order,
    processObject,
    client,
    db,
    mongoConnection,
    storage,
    repository,
    worker,
    fdkExtension,
    dryRunService,
    shipmentActivityService,
    app,
    httpServer,
    applicationConfig,
    einvoiceConfig,
    getLazyPlatformClient: () => lazyPlatformClient,
    getPreFdkPlatformResult: () => preFdkPlatformResult,
  };
}

test('production startup imports are pure and do not open MongoDB', () => {
  jest.resetModules();
  const dotenvConfig = jest.fn(() => { throw new Error('dotenv loaded on import'); });
  jest.doMock('dotenv', () => ({ config: dotenvConfig }));
  const openMongoConnection = jest.fn(() => { throw new Error('Mongo opened on import'); });
  jest.doMock('../src/mongo/mongo-connection', () => ({ openMongoConnection }));

  let startup;
  expect(() => { startup = require('../index'); }).not.toThrow();
  expect(openMongoConnection).not.toHaveBeenCalled();
  expect(dotenvConfig).not.toHaveBeenCalled();
  expect(startup).toEqual(expect.objectContaining({ main: expect.any(Function) }));

  jest.resetModules();
  jest.dontMock('../src/mongo/mongo-connection');
  jest.dontMock('dotenv');
});

test('enabled main opens one Mongo connection and initializes every owner in exact order', async () => {
  const { main } = require('../index');
  const h = harness();
  const started = await main(h.deps);

  expect(h.order).toEqual([
    'dotenv', 'app.config', 'invoice.config', 'mongo.open', 'storage.construct',
    'storage.initialize', 'repository.construct', 'repository.initialize', 'runtime',
    'fdk', 'app', 'listen', 'worker.start',
  ]);
  expect(h.deps.openMongo).toHaveBeenCalledWith({ config: h.applicationConfig.mongoConfig });
  expect(h.deps.createManagedStorage).toHaveBeenCalledWith(h.db);
  expect(h.deps.createInvoiceRepository).toHaveBeenCalledWith({
    db: h.db, client: h.client,
  });
  expect(h.deps.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
    env: h.deps.env,
    repository: h.repository,
    workerId: 'stable-process-worker-id',
    logger: h.deps.logger,
    getPlatformClient: expect.any(Function),
    loadConfig: expect.any(Function),
  }));
  expect(h.deps.createRuntime.mock.calls[0][0].loadConfig()).toBe(h.einvoiceConfig);
  expect(await h.getPreFdkPlatformResult()).toEqual(expect.objectContaining({
    code: 'FDK_CLIENT_UNAVAILABLE',
    message: 'FDK platform client is unavailable',
  }));
  await h.getLazyPlatformClient()('company-1');
  expect(h.fdkExtension.getPlatformClient).toHaveBeenCalledWith('company-1');
  expect(h.deps.createFdk).toHaveBeenCalledTimes(1);
  expect(h.deps.createFdk).toHaveBeenCalledWith(expect.objectContaining({
    env: h.deps.env,
    storage: h.storage,
    shipmentWebhookHandler: expect.any(Function),
  }));
  expect(h.deps.createApplication).toHaveBeenCalledWith({
    fdkExtension: h.fdkExtension,
    logger: h.deps.logger,
    staticPath: '/static',
    dryRunService: h.dryRunService,
    shipmentActivityService: h.shipmentActivityService,
  });
  expect(h.deps.listen).toHaveBeenCalledWith(h.app, 9090);
  expect(started).toEqual({
    app: h.app,
    server: h.httpServer,
    worker: h.worker,
    repository: h.repository,
    storage: h.storage,
    mongoConnection: h.mongoConnection,
    shutdown: expect.any(Function),
    removeSignalHandlers: expect.any(Function),
  });
  expect(Object.isFrozen(started)).toBe(true);
  expect(started).not.toHaveProperty('sessionDb');
  expect(h.client.close).not.toHaveBeenCalled();

  await started.shutdown();
  expect(h.order.slice(-6)).toEqual([
    'server.close', 'worker.stop', 'repository.close', 'storage.stop', 'mongo.close',
    'client.close',
  ]);
  expect(h.client.close).toHaveBeenCalledTimes(1);
  started.removeSignalHandlers();
});

test('disabled main still initializes Mongo FDK storage but never constructs an invoice repository', async () => {
  const { main } = require('../index');
  const h = harness();
  const disabledHandler = jest.fn();
  h.deps.loadInvoiceConfig.mockImplementation(() => {
    h.order.push('invoice.config');
    return invoiceConfig(false);
  });
  h.deps.createRuntime.mockImplementation(async options => {
    h.order.push('runtime');
    expect(options.repository).toBeNull();
    return {
      enabled: false,
      repository: null,
      worker: h.worker,
      shipmentWebhookHandler: disabledHandler,
      dryRunService: null,
      shipmentActivityService: null,
    };
  });

  const started = await main(h.deps);

  expect(h.order).toEqual([
    'dotenv', 'app.config', 'invoice.config', 'mongo.open', 'storage.construct',
    'storage.initialize', 'runtime', 'fdk', 'app', 'listen', 'worker.start',
  ]);
  expect(h.deps.createInvoiceRepository).not.toHaveBeenCalled();
  expect(h.repository.initialize).not.toHaveBeenCalled();
  expect(h.repository.close).not.toHaveBeenCalled();
  expect(started.repository).toBeNull();
  expect(h.deps.createFdk).toHaveBeenCalledWith(expect.objectContaining({
    shipmentWebhookHandler: disabledHandler,
  }));
  expect(h.deps.createApplication).toHaveBeenCalledWith(expect.objectContaining({
    dryRunService: null,
    shipmentActivityService: null,
  }));

  await started.shutdown();
  expect(h.order.slice(-5)).toEqual([
    'server.close', 'worker.stop', 'storage.stop', 'mongo.close', 'client.close',
  ]);
  started.removeSignalHandlers();
});

test('main rejects the 5000 ms transaction-timeout lease boundary before opening Mongo', async () => {
  const { main } = require('../index');
  const h = harness();
  h.deps.loadInvoiceConfig.mockReturnValue({ enabled: true, jobLeaseMs: 5000 });

  await expect(main(h.deps)).rejects.toEqual(expect.objectContaining({
    code: 'CONFIG_INTEGER_INVALID',
  }));
  expect(h.deps.openMongo).not.toHaveBeenCalled();
  expect(h.processObject.listenerCount('SIGINT')).toBe(0);
  expect(h.processObject.listenerCount('SIGTERM')).toBe(0);
});

test('strict Mongo repository assertion runs before repository initialization and runtime composition', async () => {
  const { main } = require('../index');
  const h = harness();
  const legacyOnly = Object.fromEntries(
    REPOSITORY_METHODS.slice(0, 17).map(method => [method, jest.fn()]),
  );
  legacyOnly.close.mockImplementation(async () => { h.order.push('legacy.close'); });
  h.deps.createInvoiceRepository.mockReturnValue(legacyOnly);

  await expect(main(h.deps)).rejects.toEqual(expect.objectContaining({
    code: 'REPOSITORY_PORT_INVALID',
  }));
  expect(legacyOnly.initialize).not.toHaveBeenCalled();
  expect(legacyOnly.close).toHaveBeenCalledTimes(1);
  expect(h.deps.createRuntime).not.toHaveBeenCalled();
  expect(h.storage.stop).toHaveBeenCalledTimes(1);
  expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
});

test('enabled runtime must return the exact coordinator repository and a complete worker surface', async () => {
  const { main } = require('../index');
  for (const mutation of [
    runtime => { runtime.repository = repositorySurface([]); },
    runtime => { runtime.worker = { start: jest.fn(), stop: jest.fn() }; },
    runtime => { runtime.dryRunService = null; },
    runtime => { delete runtime.dryRunService.getDryRunPodCurl; },
    runtime => { runtime.shipmentActivityService = null; },
    runtime => { runtime.extra = true; },
  ]) {
    const h = harness();
    h.deps.createRuntime.mockImplementation(async () => {
      const runtime = {
        enabled: true,
        repository: h.repository,
        worker: h.worker,
        shipmentWebhookHandler: jest.fn(),
        dryRunService: h.dryRunService,
        shipmentActivityService: h.shipmentActivityService,
      };
      mutation(runtime);
      return runtime;
    });

    await expect(main(h.deps)).rejects.toEqual(expect.objectContaining({
      code: 'INVOICE_RUNTIME_INVALID',
      message: 'Invoice runtime is invalid',
    }));
    expect(h.repository.close).toHaveBeenCalledTimes(1);
    expect(h.storage.stop).toHaveBeenCalledTimes(1);
    expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
    expect(h.deps.createFdk).not.toHaveBeenCalled();
  }
});

test('runtime accessors, proxies, inherited values, arrays, and class instances fail without exposing details', async () => {
  const { main } = require('../index');
  let accessorReads = 0;
  const valid = h => ({
    enabled: true,
    repository: h.repository,
    worker: h.worker,
    shipmentWebhookHandler: jest.fn(),
    dryRunService: h.dryRunService,
    shipmentActivityService: h.shipmentActivityService,
  });
  const makers = [
    h => Object.create(valid(h)),
    h => {
      const value = valid(h);
      Object.defineProperty(value, 'enabled', {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error('private runtime accessor');
        },
      });
      return value;
    },
    h => new Proxy(valid(h), {
      getOwnPropertyDescriptor() { throw new Error('private runtime proxy'); },
    }),
    h => Object.assign([], valid(h)),
    h => {
      class RuntimeSurface {
        constructor() { Object.assign(this, valid(h)); }
      }
      return new RuntimeSurface();
    },
  ];

  for (const make of makers) {
    const h = harness();
    h.deps.createRuntime.mockResolvedValue(make(h));
    const error = await main(h.deps).catch(value => value);
    expect(error).toEqual(expect.objectContaining({
      code: 'INVOICE_RUNTIME_INVALID',
      message: 'Invoice runtime is invalid',
    }));
    expect(`${error.message} ${error.stack}`).not.toContain('private runtime');
    expect(h.repository.close).toHaveBeenCalledTimes(1);
    expect(h.storage.stop).toHaveBeenCalledTimes(1);
    expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
  }
  expect(accessorReads).toBe(0);
});

test('a Proxy webhook handler is rejected before FDK without executing its traps', async () => {
  const { main } = require('../index');
  const h = harness();
  let applyCalls = 0;
  const proxyHandler = new Proxy(jest.fn(), {
    apply() {
      applyCalls += 1;
      throw new Error('private webhook proxy');
    },
  });
  h.deps.createRuntime.mockResolvedValue({
    enabled: true,
    repository: h.repository,
    worker: h.worker,
    shipmentWebhookHandler: proxyHandler,
    dryRunService: h.dryRunService,
    shipmentActivityService: h.shipmentActivityService,
  });

  const outcome = await main(h.deps).catch(error => error);
  if (outcome && typeof outcome.shutdown === 'function') await outcome.shutdown();

  expect(outcome).toEqual(expect.objectContaining({
    code: 'INVOICE_RUNTIME_INVALID',
    message: 'Invoice runtime is invalid',
  }));
  expect(`${outcome.message} ${outcome.stack}`).not.toContain('private webhook');
  expect(applyCalls).toBe(0);
  expect(h.deps.createFdk).not.toHaveBeenCalled();
  expect(h.worker.stop).toHaveBeenCalledTimes(1);
  expect(h.repository.close).toHaveBeenCalledTimes(1);
  expect(h.storage.stop).toHaveBeenCalledTimes(1);
  expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
});

test('hostile shipment activity service surfaces fail before FDK without executing traps', async () => {
  const { main } = require('../index');
  let trapCalls = 0;
  const valid = () => ({
    listShipments: jest.fn(), listPreJobFailures: jest.fn(), getTimeline: jest.fn(),
  });
  class ActivityService {
    constructor() { Object.assign(this, valid()); }
  }
  const candidates = [
    { listShipments: jest.fn() },
    { ...valid(), extra: jest.fn() },
    Object.create(valid()),
    Object.assign([], valid()),
    new ActivityService(),
    new Proxy(valid(), {
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error('private activity proxy');
      },
    }),
  ];

  for (const shipmentActivityService of candidates) {
    const h = harness();
    h.deps.createRuntime.mockResolvedValue({
      enabled: true,
      repository: h.repository,
      worker: h.worker,
      shipmentWebhookHandler: jest.fn(),
      dryRunService: h.dryRunService,
      shipmentActivityService,
    });
    const error = await main(h.deps).catch(value => value);
    expect(error).toEqual(expect.objectContaining({
      code: 'INVOICE_RUNTIME_INVALID',
      message: 'Invoice runtime is invalid',
    }));
    expect(`${error.message} ${error.stack}`).not.toContain('private activity');
    expect(h.deps.createFdk).not.toHaveBeenCalled();
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    expect(h.repository.close).toHaveBeenCalledTimes(1);
    expect(h.storage.stop).toHaveBeenCalledTimes(1);
    expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
  }
  expect(trapCalls).toBe(0);
});

test('invalid connection containers fail closed without reading accessors or connection internals', async () => {
  const { main } = require('../index');
  let accessorReads = 0;
  const makers = [
    h => Object.create(h.mongoConnection),
    h => {
      const value = { client: h.client, db: h.db };
      Object.defineProperty(value, 'close', {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error('private connection accessor');
        },
      });
      return value;
    },
    h => new Proxy(h.mongoConnection, {
      getOwnPropertyDescriptor() { throw new Error('private connection proxy'); },
    }),
    h => Object.assign([], h.mongoConnection),
    h => {
      class ConnectionSurface {
        constructor() { Object.assign(this, h.mongoConnection); }
      }
      return new ConnectionSurface();
    },
  ];

  for (const make of makers) {
    const h = harness();
    h.deps.openMongo.mockResolvedValue(make(h));
    const error = await main(h.deps).catch(value => value);
    expect(error).toEqual(expect.objectContaining({
      code: 'MONGO_CONNECTION_INVALID',
      message: 'Mongo connection is invalid',
    }));
    expect(`${error.message} ${error.stack}`).not.toContain('private connection');
    expect(h.deps.createManagedStorage).not.toHaveBeenCalled();
  }
  expect(accessorReads).toBe(0);
});

test('a malformed resolved Mongo connection is ledgered and safely closed before rejection', async () => {
  const { main } = require('../index');
  const h = harness();
  const malformedConnection = { ...h.mongoConnection, unexpected: true };
  h.deps.openMongo.mockResolvedValue(malformedConnection);

  await expect(main(h.deps)).rejects.toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_INVALID',
    message: 'Mongo connection is invalid',
  }));

  expect(h.deps.createManagedStorage).not.toHaveBeenCalled();
  expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
  expect(h.client.close).toHaveBeenCalledTimes(1);
  expect(h.processObject.listenerCount('SIGINT')).toBe(0);
  expect(h.processObject.listenerCount('SIGTERM')).toBe(0);
});

test.each([
  ['undefined', undefined],
  ['a non-closable object', {}],
])('a listener resolving %s is rejected before the worker starts', async (_description, server) => {
  const { main } = require('../index');
  const h = harness();
  h.deps.listen.mockResolvedValue(server);

  const outcome = await main(h.deps).catch(error => error);
  if (outcome && typeof outcome.shutdown === 'function') await outcome.shutdown();

  expect(outcome).toEqual(expect.objectContaining({
    code: 'HTTP_SERVER_INVALID',
    message: 'HTTP server is invalid',
  }));
  expect(h.worker.start).not.toHaveBeenCalled();
  expect(h.worker.stop).toHaveBeenCalledTimes(1);
  expect(h.repository.close).toHaveBeenCalledTimes(1);
  expect(h.storage.stop).toHaveBeenCalledTimes(1);
  expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
  expect(h.processObject.listenerCount('SIGINT')).toBe(0);
  expect(h.processObject.listenerCount('SIGTERM')).toBe(0);
});

test('the listener rejects a frozen emitted error without mutation or a pending promise', async () => {
  const { listenForRequests } = require('../index');
  const primary = Object.freeze(Object.assign(new Error('safe listen failure'), {
    code: 'SAFE_LISTEN_FAILURE',
  }));
  let handlerFailure = null;
  const server = {
    close: jest.fn(callback => callback(null)),
    once: jest.fn((_event, handler) => {
      try {
        handler(primary);
      } catch (error) {
        handlerFailure = error;
      }
    }),
    removeListener: jest.fn(),
  };
  const app = { listen: jest.fn(() => server) };

  const outcome = await Promise.race([
    listenForRequests(app, 9090).then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error }),
    ),
    new Promise(resolve => setImmediate(() => resolve({ status: 'pending' }))),
  ]);

  expect(handlerFailure).toBeNull();
  expect(outcome).toEqual({ status: 'rejected', error: primary });
  expect(Object.prototype.hasOwnProperty.call(primary, 'httpServer')).toBe(false);
});

test('main drains the partial server associated with a frozen listen error', async () => {
  const { listenForRequests, main } = require('../index');
  const h = harness();
  const primary = Object.freeze(Object.assign(new Error('safe listen failure'), {
    code: 'SAFE_LISTEN_FAILURE',
  }));
  const server = {
    close: jest.fn(callback => {
      h.order.push('partial-server.close');
      callback(null);
    }),
    once: jest.fn((_event, handler) => handler(primary)),
    removeListener: jest.fn(),
  };
  h.deps.createApplication.mockReturnValue({ listen: jest.fn(() => server) });
  h.deps.listen = listenForRequests;

  await expect(main(h.deps)).rejects.toBe(primary);

  expect(Object.prototype.hasOwnProperty.call(primary, 'httpServer')).toBe(false);
  expect(server.close).toHaveBeenCalledTimes(1);
  expect(h.order.slice(-6)).toEqual([
    'partial-server.close', 'worker.stop', 'repository.close', 'storage.stop',
    'mongo.close', 'client.close',
  ]);
  expect(h.client.close).toHaveBeenCalledTimes(1);
});

test('startup failure matrix drains only acquired resources and preserves the primary error', async () => {
  const { main } = require('../index');
  const stages = [
    'dotenv', 'applicationConfig', 'invoiceConfig', 'port', 'mongo',
    'storageConstruct', 'storageInitialize', 'repositoryConstruct',
    'repositoryInitialize', 'runtime', 'fdk', 'app', 'listen', 'worker',
  ];
  for (const stage of stages) {
    const primary = Object.assign(new Error(`safe ${stage} failure`), {
      code: `SAFE_${stage.toUpperCase()}`,
    });
    const h = harness();
    if (stage === 'dotenv') h.deps.loadDotenv.mockImplementation(() => { throw primary; });
    if (stage === 'applicationConfig') h.deps.loadApplicationConfig.mockImplementation(() => { throw primary; });
    if (stage === 'invoiceConfig') h.deps.loadInvoiceConfig.mockImplementation(() => { throw primary; });
    if (stage === 'port') h.deps.env.BACKEND_PORT = '0';
    if (stage === 'mongo') h.deps.openMongo.mockRejectedValue(primary);
    if (stage === 'storageConstruct') h.deps.createManagedStorage.mockImplementation(() => { throw primary; });
    if (stage === 'storageInitialize') h.storage.initialize.mockRejectedValue(primary);
    if (stage === 'repositoryConstruct') h.deps.createInvoiceRepository.mockImplementation(() => { throw primary; });
    if (stage === 'repositoryInitialize') h.repository.initialize.mockRejectedValue(primary);
    if (stage === 'runtime') h.deps.createRuntime.mockRejectedValue(primary);
    if (stage === 'fdk') h.deps.createFdk.mockRejectedValue(primary);
    if (stage === 'app') h.deps.createApplication.mockImplementation(() => { throw primary; });
    if (stage === 'listen') {
      primary.httpServer = h.httpServer;
      h.deps.listen.mockRejectedValue(primary);
    }
    if (stage === 'worker') h.worker.start.mockRejectedValue(primary);

    const error = await main(h.deps).catch(value => value);
    if (stage === 'port') {
      expect(error).toEqual(expect.objectContaining({ code: 'PORT_INVALID' }));
    } else {
      expect(error).toBe(primary);
    }
    const mongoAcquired = ![
      'dotenv', 'applicationConfig', 'invoiceConfig', 'port', 'mongo',
    ].includes(stage);
    const storageAcquired = mongoAcquired && stage !== 'storageConstruct';
    const repositoryAcquired = storageAcquired
      && !['storageInitialize', 'repositoryConstruct'].includes(stage);
    const workerSurfaced = ['fdk', 'app', 'listen', 'worker'].includes(stage);
    const serverAcquired = ['listen', 'worker'].includes(stage);
    expect(h.mongoConnection.close).toHaveBeenCalledTimes(mongoAcquired ? 1 : 0);
    expect(h.storage.stop).toHaveBeenCalledTimes(storageAcquired ? 1 : 0);
    expect(h.repository.close).toHaveBeenCalledTimes(repositoryAcquired ? 1 : 0);
    expect(h.worker.stop).toHaveBeenCalledTimes(workerSurfaced ? 1 : 0);
    expect(h.httpServer.close).toHaveBeenCalledTimes(serverAcquired ? 1 : 0);
    expect(h.processObject.listenerCount('SIGINT')).toBe(0);
    expect(h.processObject.listenerCount('SIGTERM')).toBe(0);
  }
});

test('runtime validation failure drains a safely surfaced worker before repository and Mongo', async () => {
  const { main } = require('../index');
  const h = harness();
  h.deps.createRuntime.mockResolvedValue({
    enabled: true,
    repository: h.repository,
    worker: h.worker,
    shipmentWebhookHandler: null,
    dryRunService: h.dryRunService,
    shipmentActivityService: h.shipmentActivityService,
  });

  await expect(main(h.deps)).rejects.toEqual(expect.objectContaining({
    code: 'INVOICE_RUNTIME_INVALID',
  }));
  expect(h.order.slice(-5)).toEqual([
    'worker.stop', 'repository.close', 'storage.stop', 'mongo.close', 'client.close',
  ]);
});

test('shutdown is cached and strictly drains server, worker, repository, storage, then Mongo', async () => {
  const { createShutdownCoordinator, registerSignalHandlers } = require('../index');
  const order = [];
  const drains = {
    server: deferred(), worker: deferred(), repository: deferred(), storage: deferred(),
  };
  const processObject = new EventEmitter();
  processObject.exitCode = undefined;
  const resources = {
    startupSettled: Promise.resolve(),
    shutdownRequested: false,
    server: {
      close: jest.fn(callback => {
        order.push('server.begin');
        drains.server.promise.then(() => callback(null));
      }),
    },
    worker: {
      stop: jest.fn(() => { order.push('worker.begin'); return drains.worker.promise; }),
    },
    repository: {
      close: jest.fn(() => {
        order.push('repository.begin');
        return drains.repository.promise;
      }),
    },
    storage: {
      stop: jest.fn(() => { order.push('storage.begin'); return drains.storage.promise; }),
    },
    mongoConnection: {
      close: jest.fn(async () => { order.push('mongo.close'); }),
    },
  };
  const logger = { error: jest.fn() };
  const shutdown = createShutdownCoordinator({ resources, logger, processObject });
  const remove = registerSignalHandlers({ processObject, shutdown });

  processObject.emit('SIGINT');
  processObject.emit('SIGTERM');
  const first = shutdown();
  expect(shutdown()).toBe(first);
  await Promise.resolve();
  expect(order).toEqual(['server.begin']);

  drains.server.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual(['server.begin', 'worker.begin']);
  drains.worker.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual(['server.begin', 'worker.begin', 'repository.begin']);
  drains.repository.resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual([
    'server.begin', 'worker.begin', 'repository.begin', 'storage.begin',
  ]);
  drains.storage.resolve();
  await first;
  expect(order).toEqual([
    'server.begin', 'worker.begin', 'repository.begin', 'storage.begin', 'mongo.close',
  ]);
  for (const resource of [
    resources.server, resources.worker, resources.repository,
    resources.storage, resources.mongoConnection,
  ]) {
    const method = resource.close || resource.stop;
    expect(method).toHaveBeenCalledTimes(1);
  }
  expect(logger.error).not.toHaveBeenCalled();
  remove();
});

test('cleanup failures are sanitized, do not stop later cleanup, and set exitCode', async () => {
  const { createShutdownCoordinator } = require('../index');
  const order = [];
  const processObject = { exitCode: undefined };
  const failure = () => Promise.reject(new Error('private cleanup detail'));
  const resources = {
    startupSettled: Promise.resolve(),
    shutdownRequested: false,
    server: { close: jest.fn(callback => { order.push('server'); callback(new Error('raw')); }) },
    worker: { stop: jest.fn(() => { order.push('worker'); return failure(); }) },
    repository: { close: jest.fn(() => { order.push('repository'); return failure(); }) },
    storage: { stop: jest.fn(() => { order.push('storage'); return failure(); }) },
    mongoConnection: { close: jest.fn(() => { order.push('mongo'); return failure(); }) },
  };
  const logger = { error: jest.fn() };

  await createShutdownCoordinator({ resources, logger, processObject })();

  expect(order).toEqual(['server', 'worker', 'repository', 'storage', 'mongo']);
  expect(logger.error).toHaveBeenCalledTimes(5);
  expect(logger.error).toHaveBeenNthCalledWith(
    1, 'Shutdown cleanup failed', 'SHUTDOWN_CLEANUP_FAILED',
  );
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private cleanup');
  expect(processObject.exitCode).toBe(1);
});

test('a throwing cleanup logger cannot stop later drains or replace shutdown completion', async () => {
  const { createShutdownCoordinator } = require('../index');
  const order = [];
  const processObject = { exitCode: undefined };
  const resources = {
    startupSettled: Promise.resolve(),
    shutdownRequested: false,
    server: {
      close: jest.fn(callback => {
        order.push('server');
        callback(new Error('private server close failure'));
      }),
    },
    worker: { stop: jest.fn(async () => { order.push('worker'); }) },
    repository: { close: jest.fn(async () => { order.push('repository'); }) },
    storage: { stop: jest.fn(async () => { order.push('storage'); }) },
    mongoConnection: { close: jest.fn(async () => { order.push('mongo'); }) },
  };
  const logger = {
    error: jest.fn(() => { throw new Error('private logger failure'); }),
  };

  await expect(createShutdownCoordinator({ resources, logger, processObject })())
    .resolves.toBeUndefined();

  expect(order).toEqual(['server', 'worker', 'repository', 'storage', 'mongo']);
  expect(logger.error).toHaveBeenCalledWith(
    'Shutdown cleanup failed', 'SHUTDOWN_CLEANUP_FAILED',
  );
  expect(processObject.exitCode).toBe(1);
});

test.each(['mongo', 'storage', 'repository', 'fdk', 'listen', 'worker'])(
  'a signal during pending %s acquisition waits, records it, then drains in order',
  async stage => {
    const { main } = require('../index');
    const h = harness();
    const pending = deferred();
    const stageMocks = {
      mongo: h.deps.openMongo,
      storage: h.storage.initialize,
      repository: h.repository.initialize,
      fdk: h.deps.createFdk,
      listen: h.deps.listen,
      worker: h.worker.start,
    };
    if (stage === 'mongo') h.deps.openMongo.mockImplementation(() => pending.promise);
    if (stage === 'storage') h.storage.initialize.mockImplementation(() => pending.promise);
    if (stage === 'repository') h.repository.initialize.mockImplementation(() => pending.promise);
    if (stage === 'fdk') h.deps.createFdk.mockImplementation(() => pending.promise);
    if (stage === 'listen') h.deps.listen.mockImplementation(() => pending.promise);
    if (stage === 'worker') h.worker.start.mockImplementation(() => pending.promise);

    const starting = main(h.deps);
    await waitForCall(stageMocks[stage]);
    h.processObject.emit('SIGTERM');
    expect(h.mongoConnection.close).not.toHaveBeenCalled();
    pending.resolve({
      mongo: h.mongoConnection,
      storage: undefined,
      repository: undefined,
      fdk: h.fdkExtension,
      listen: h.httpServer,
      worker: undefined,
    }[stage]);

    await expect(starting).rejects.toEqual(expect.objectContaining({
      code: 'STARTUP_ABORTED',
      message: 'Application startup was interrupted',
    }));
    expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
    expect(h.storage.stop).toHaveBeenCalledTimes(stage === 'mongo' ? 0 : 1);
    expect(h.repository.close).toHaveBeenCalledTimes(
      ['mongo', 'storage'].includes(stage) ? 0 : 1,
    );
    expect(h.worker.stop).toHaveBeenCalledTimes(
      ['fdk', 'listen', 'worker'].includes(stage) ? 1 : 0,
    );
    expect(h.httpServer.close).toHaveBeenCalledTimes(
      ['listen', 'worker'].includes(stage) ? 1 : 0,
    );
    expect(h.processObject.listenerCount('SIGINT')).toBe(0);
    expect(h.processObject.listenerCount('SIGTERM')).toBe(0);
  },
);

test('FDK setup is one-shot per main invocation and is never retried after failure', async () => {
  const { main } = require('../index');
  const h = harness();
  const primary = Object.assign(new Error('safe FDK failure'), { code: 'FDK_INITIALIZATION_FAILED' });
  h.deps.createFdk.mockRejectedValue(primary);

  await expect(main(h.deps)).rejects.toBe(primary);
  expect(h.deps.createFdk).toHaveBeenCalledTimes(1);
  expect(h.deps.createApplication).not.toHaveBeenCalled();
  expect(h.worker.stop).toHaveBeenCalledTimes(1);
  expect(h.repository.close).toHaveBeenCalledTimes(1);
  expect(h.storage.stop).toHaveBeenCalledTimes(1);
  expect(h.mongoConnection.close).toHaveBeenCalledTimes(1);
});
