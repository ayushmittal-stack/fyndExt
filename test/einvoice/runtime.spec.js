'use strict';

const { createInvoiceRuntime } = require('../../src/einvoice/runtime');
const { OEIS_UPDATE_PATH } = require('../../src/einvoice/clients/oeis-client');
const { buildOeisPayload } = require('../../src/einvoice/payload-builder');
const { createTaxPolicyResolver } = require('../../src/einvoice/tax-policy-resolver');

const MONGO_REPOSITORY_METHODS = Object.freeze([
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
]);

function mongoRepository() {
  return Object.fromEntries(MONGO_REPOSITORY_METHODS.map(method => [method, jest.fn()]));
}

function enabledConfig() {
  return {
    enabled: true,
    masterDataPath: '/data/master.json',
    baseUrl: 'https://oeis.example.test',
    apiKey: 'opaque-key',
    timeoutMs: 1234,
    maxRequestBytes: 4096,
    maxResponseBytes: 8192,
    companyCode: 'COMPANY',
    sourceErp: 'Fynd.com',
    supplierCountryCode: 'SA',
    amountTolerance: '0.01',
    workerPollMs: 100,
    jobLeaseMs: 5001,
    maxAttempts: 5,
    retryBaseMs: 100,
    dryRunEnabled: false,
  };
}

function composition(overrides = {}) {
  const order = [];
  const repository = mongoRepository();
  const isolatedAxios = { post: jest.fn(), defaults: {} };
  const masterData = { kind: 'master' };
  const oeisClient = { submit: jest.fn() };
  const fyndClient = {
    lockShipment: jest.fn(), transitionToInvoiced: jest.fn(), getShipment: jest.fn(),
  };
  const workflow = { processJob: jest.fn(), processOutbox: jest.fn() };
  const taxPolicyResolver = { resolveLineTax: jest.fn() };
  const worker = { start: jest.fn(), runOnce: jest.fn(), stop: jest.fn() };
  const handler = jest.fn();
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
  const deps = {
    env: { EINVOICE_ENABLED: 'true' },
    repository,
    workerId: 'worker-process-id',
    logger: { error: jest.fn() },
    now: jest.fn(() => new Date('2026-08-10T00:00:00.000Z')),
    getPlatformClient: jest.fn(),
    loadConfig: jest.fn(() => { order.push('config'); return enabledConfig(); }),
    loadMaster: jest.fn(() => { order.push('master'); return masterData; }),
    axiosLibrary: { create: jest.fn(() => { order.push('axios'); return isolatedAxios; }) },
    createOeis: jest.fn(() => { order.push('oeis'); return oeisClient; }),
    createFynd: jest.fn(() => { order.push('fynd'); return fyndClient; }),
    createTaxResolver: jest.fn(() => { order.push('tax-policy'); return taxPolicyResolver; }),
    buildPayload: jest.fn(),
    createWorkflow: jest.fn(() => { order.push('workflow'); return workflow; }),
    createWorker: jest.fn(() => { order.push('worker'); return worker; }),
    createWebhookHandler: jest.fn(() => { order.push('handler'); return handler; }),
    createDryRun: jest.fn(() => { order.push('dry-run'); return dryRunService; }),
    createShipmentActivity: jest.fn(() => {
      order.push('shipment-activity');
      return shipmentActivityService;
    }),
    parseResponse: jest.fn(),
    ...overrides,
  };
  return {
    deps,
    order,
    repository,
    isolatedAxios,
    masterData,
    oeisClient,
    fyndClient,
    workflow,
    worker,
    handler,
    dryRunService,
    shipmentActivityService,
    taxPolicyResolver,
  };
}

test('disabled runtime requires a null repository and returns before all invoice composition', async () => {
  const forbidden = jest.fn(() => { throw new Error('must not run'); });
  const runtime = await createInvoiceRuntime({
    env: { EINVOICE_ENABLED: 'false' },
    repository: null,
    loadConfig: jest.fn(() => ({ enabled: false })),
    loadMaster: forbidden,
    axiosLibrary: { create: forbidden },
    createOeis: forbidden,
    createFynd: forbidden,
    createWorkflow: forbidden,
    createWorker: forbidden,
    createWebhookHandler: forbidden,
  });

  expect(runtime.enabled).toBe(false);
  expect(runtime.repository).toBeNull();
  expect(runtime.dryRunService).toBeNull();
  expect(runtime.shipmentActivityService).toBeNull();
  await expect(runtime.shipmentWebhookHandler()).resolves.toEqual({
    acknowledged: true, ignored: 'disabled',
  });
  await expect(runtime.worker.start()).resolves.toBeUndefined();
  await expect(runtime.worker.runOnce()).resolves.toBeUndefined();
  await expect(runtime.worker.stop()).resolves.toBeUndefined();
  expect(forbidden).not.toHaveBeenCalled();
});

test.each([undefined, {}, mongoRepository()])(
  'disabled runtime rejects a non-null coordinator repository without inspecting it',
  async repository => {
    const forbidden = jest.fn(() => { throw new Error('must not run'); });
    await expect(createInvoiceRuntime({
      env: { EINVOICE_ENABLED: 'false' },
      repository,
      loadConfig: jest.fn(() => ({ enabled: false })),
      loadMaster: forbidden,
    })).rejects.toEqual(expect.objectContaining({
      code: 'RUNTIME_CONFIG_INVALID',
      message: 'Invoice runtime configuration is invalid',
    }));
    expect(forbidden).not.toHaveBeenCalled();
  },
);

test('enabled runtime consumes the ready Mongo repository and composes in the audited order', async () => {
  const c = composition();
  const runtime = await createInvoiceRuntime(c.deps);

  expect(c.order).toEqual([
    'config', 'master', 'tax-policy', 'axios', 'dry-run', 'shipment-activity', 'oeis', 'fynd',
    'workflow', 'worker', 'handler',
  ]);
  expect(runtime).toEqual({
    enabled: true,
    shipmentWebhookHandler: c.handler,
    worker: c.worker,
    repository: c.repository,
    dryRunService: expect.objectContaining({
      listDryRuns: c.dryRunService.listDryRuns,
      listDryRunFailures: c.dryRunService.listDryRunFailures,
      getDryRunJourney: c.dryRunService.getDryRunJourney,
      getDryRunRequest: c.dryRunService.getDryRunRequest,
      getDryRunPodCurl: c.dryRunService.getDryRunPodCurl,
    }),
    shipmentActivityService: expect.objectContaining({
      listShipments: c.shipmentActivityService.listShipments,
      listPreJobFailures: c.shipmentActivityService.listPreJobFailures,
      getTimeline: c.shipmentActivityService.getTimeline,
    }),
  });
  expect(runtime.repository).toBe(c.repository);
  expect(c.repository.initialize).not.toHaveBeenCalled();
  expect(c.repository.close).not.toHaveBeenCalled();
  expect(c.deps.createDryRun).toHaveBeenCalledWith({
    repository: c.repository,
    oeisBaseUrl: 'https://oeis.example.test',
    oeisApiKey: 'opaque-key',
    maxRequestBytes: 4096,
  });
  expect(c.deps.createShipmentActivity).toHaveBeenCalledWith({
    repository: c.repository,
    now: c.deps.now,
  });
  expect(c.deps.axiosLibrary.create).toHaveBeenCalledWith();
  expect(c.deps.createOeis).toHaveBeenCalledWith({
    axiosInstance: c.isolatedAxios,
    baseUrl: 'https://oeis.example.test',
    apiKey: 'opaque-key',
    timeoutMs: 1234,
    maxRequestBytes: 4096,
    maxResponseBytes: 8192,
  });
  expect(c.deps.createFynd).toHaveBeenCalledWith({
    getPlatformClient: c.deps.getPlatformClient,
  });
  expect(c.deps.createTaxResolver).toHaveBeenCalledWith({
    policyVersion: '2026-08-17', now: c.deps.now,
  });
  expect(c.deps.getPlatformClient).not.toHaveBeenCalled();
  const workflowOptions = c.deps.createWorkflow.mock.calls[0][0];
  expect(workflowOptions).toEqual({
    repository: c.repository,
    buildPayload: expect.any(Function),
    oeisClient: c.oeisClient,
    parseResponse: c.deps.parseResponse,
    fyndClient: c.fyndClient,
    now: c.deps.now,
    oeisAudit: {
      endpointPath: OEIS_UPDATE_PATH,
      timeoutMs: 1234,
    },
  });
  expect(Reflect.ownKeys(workflowOptions)).toEqual([
    'repository', 'buildPayload', 'oeisClient', 'parseResponse', 'fyndClient',
    'now', 'oeisAudit',
  ]);
  expect(workflowOptions.oeisAudit).not.toHaveProperty('baseUrl');
  expect(workflowOptions.oeisAudit).not.toHaveProperty('apiKey');
  const snapshot = { shipmentId: 'S1' };
  workflowOptions.buildPayload(snapshot);
  expect(c.deps.buildPayload).toHaveBeenCalledWith(snapshot, {
    companyCode: 'COMPANY',
    sourceErp: 'Fynd.com',
    supplierCountryCode: 'SA',
    amountTolerance: '0.01',
    masterData: c.masterData,
    taxPolicyResolver: c.taxPolicyResolver,
  });
  expect(c.deps.createWorker).toHaveBeenCalledWith({
    repository: c.repository,
    workflow: c.workflow,
    workerId: 'worker-process-id',
    pollMs: 100,
    leaseMs: 5001,
    maxAttempts: 5,
    retryBaseMs: 100,
    logger: c.deps.logger,
    now: c.deps.now,
    policyVersion: '2026-08-17',
  });
  expect(c.deps.createWebhookHandler).toHaveBeenCalledWith({
    enabled: true,
    dryRunEnabled: false,
    repository: c.repository,
    logger: c.deps.logger,
    now: c.deps.now,
  });
});

test('enabled runtime validates the strict Mongo repository before loading master data', async () => {
  const legacyRepository = Object.fromEntries(
    MONGO_REPOSITORY_METHODS.slice(0, 17).map(method => [method, jest.fn()]),
  );
  const c = composition({ repository: legacyRepository });

  await expect(createInvoiceRuntime(c.deps)).rejects.toEqual(expect.objectContaining({
    code: 'RUNTIME_CONFIG_INVALID',
    message: 'Invoice runtime configuration is invalid',
  }));
  expect(c.deps.loadMaster).not.toHaveBeenCalled();
});

test('unsafe repository surfaces fail closed without running accessors or composition', async () => {
  let accessorReads = 0;
  const accessorRepository = mongoRepository();
  Object.defineProperty(accessorRepository, 'initialize', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('private repository accessor');
    },
  });
  const inheritedRepository = Object.create(mongoRepository());
  const proxyRepository = new Proxy(mongoRepository(), {
    getOwnPropertyDescriptor() { throw new Error('private repository proxy'); },
  });
  const arrayRepository = Object.assign([], mongoRepository());
  class RepositorySurface {
    constructor() { Object.assign(this, mongoRepository()); }
  }

  for (const repository of [
    accessorRepository, inheritedRepository, proxyRepository, arrayRepository,
    new RepositorySurface(),
  ]) {
    const c = composition({ repository });
    await expect(createInvoiceRuntime(c.deps)).rejects.toEqual(expect.objectContaining({
      code: 'RUNTIME_CONFIG_INVALID',
      message: 'Invoice runtime configuration is invalid',
    }));
    expect(c.deps.loadMaster).not.toHaveBeenCalled();
  }
  expect(accessorReads).toBe(0);
});

test('runtime never initializes or closes the injected repository on downstream failure', async () => {
  for (const stage of [
    'master', 'tax-policy', 'dry-run', 'shipment-activity', 'axios', 'oeis', 'fynd',
    'workflow', 'worker', 'handler',
  ]) {
    const primary = Object.assign(new Error(`safe ${stage} failure`), {
      code: `SAFE_${stage.toUpperCase()}`,
    });
    const c = composition();
    if (stage === 'master') c.deps.loadMaster.mockImplementation(() => { throw primary; });
    else if (stage === 'tax-policy') c.deps.createTaxResolver.mockImplementation(() => { throw primary; });
    else if (stage === 'dry-run') c.deps.createDryRun.mockImplementation(() => { throw primary; });
    else if (stage === 'shipment-activity') {
      c.deps.createShipmentActivity.mockImplementation(() => { throw primary; });
    }
    else if (stage === 'axios') c.deps.axiosLibrary.create.mockImplementation(() => { throw primary; });
    else {
      const key = {
        oeis: 'createOeis',
        fynd: 'createFynd',
        workflow: 'createWorkflow',
        worker: 'createWorker',
        handler: 'createWebhookHandler',
      }[stage];
      c.deps[key].mockImplementation(() => { throw primary; });
    }

    await expect(createInvoiceRuntime(c.deps)).rejects.toBe(primary);
    expect(c.repository.initialize).not.toHaveBeenCalled();
    expect(c.repository.close).not.toHaveBeenCalled();
  }
});

test('invalid tax resolver and dry-run surfaces fail safely without repository lifecycle calls', async () => {
  const invalidCases = [
    { createTaxResolver: jest.fn(() => ({ resolveLineTax: null })) },
    { createDryRun: jest.fn(() => ({
      listDryRuns: jest.fn(), getDryRunJourney: jest.fn(), getDryRunRequest: jest.fn(),
    })) },
    { createShipmentActivity: jest.fn(() => ({ listShipments: jest.fn() })) },
  ];
  for (const override of invalidCases) {
    const c = composition(override);
    await expect(createInvoiceRuntime(c.deps)).rejects.toEqual(expect.objectContaining({
      code: 'RUNTIME_CONFIG_INVALID',
      message: 'Invoice runtime configuration is invalid',
    }));
    expect(c.repository.initialize).not.toHaveBeenCalled();
    expect(c.repository.close).not.toHaveBeenCalled();
  }
});

test('worker accessors, proxies, inherited values, arrays, and class instances fail safely', async () => {
  let accessorReads = 0;
  const validWorker = () => ({
    start: jest.fn(),
    runOnce: jest.fn(),
    stop: jest.fn(),
  });
  const makers = [
    () => {
      const worker = validWorker();
      Object.defineProperty(worker, 'start', {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error('private worker accessor');
        },
      });
      return worker;
    },
    () => new Proxy(validWorker(), {
      get() { throw new Error('private worker proxy'); },
    }),
    () => Object.create(validWorker()),
    () => Object.assign([], validWorker()),
    () => {
      class WorkerSurface {
        start() {}

        runOnce() {}

        stop() {}
      }
      return new WorkerSurface();
    },
  ];

  for (const makeWorker of makers) {
    const c = composition({ createWorker: jest.fn(makeWorker) });
    const error = await createInvoiceRuntime(c.deps).catch(value => value);
    expect(error).toEqual(expect.objectContaining({
      code: 'RUNTIME_CONFIG_INVALID',
      message: 'Invoice runtime configuration is invalid',
    }));
    expect(`${error.message} ${error.stack}`).not.toContain('private worker');
    expect(c.repository.initialize).not.toHaveBeenCalled();
    expect(c.repository.close).not.toHaveBeenCalled();
  }
  expect(accessorReads).toBe(0);
});

test('runtime rejects a Proxy webhook handler without executing its apply trap', async () => {
  let applyCalls = 0;
  const proxyHandler = new Proxy(jest.fn(), {
    apply() {
      applyCalls += 1;
      throw new Error('private webhook proxy');
    },
  });
  const c = composition({
    createWebhookHandler: jest.fn(() => proxyHandler),
  });

  const error = await createInvoiceRuntime(c.deps).catch(value => value);

  expect(error).toEqual(expect.objectContaining({
    code: 'RUNTIME_CONFIG_INVALID',
    message: 'Invoice runtime configuration is invalid',
  }));
  expect(`${error.message} ${error.stack}`).not.toContain('private webhook');
  expect(applyCalls).toBe(0);
  expect(c.repository.initialize).not.toHaveBeenCalled();
  expect(c.repository.close).not.toHaveBeenCalled();
});

test('snapshots dry-run service methods into a stable plain own-data surface', async () => {
  const c = composition();
  const runtime = await createInvoiceRuntime(c.deps);
  c.dryRunService.listDryRuns = null;

  expect(Object.getPrototypeOf(runtime.dryRunService)).toBe(Object.prototype);
  expect(Object.isFrozen(runtime.dryRunService)).toBe(true);
  expect(Reflect.ownKeys(runtime.dryRunService)).toEqual([
    'listDryRuns', 'listDryRunFailures', 'getDryRunJourney', 'getDryRunRequest',
    'getDryRunPodCurl',
  ]);
  expect(runtime.dryRunService.listDryRuns).toEqual(expect.any(Function));
  expect(runtime.dryRunService.getDryRunPodCurl).toEqual(expect.any(Function));
  expect(Object.getOwnPropertyDescriptor(runtime.dryRunService, 'listDryRuns'))
    .toEqual(expect.objectContaining({ value: expect.any(Function) }));
});

test('snapshots shipment activity methods into a stable exact plain own-data surface', async () => {
  const c = composition();
  const runtime = await createInvoiceRuntime(c.deps);
  c.shipmentActivityService.listShipments = null;

  expect(Reflect.ownKeys(runtime.shipmentActivityService)).toEqual([
    'listShipments', 'listPreJobFailures', 'getTimeline',
  ]);
  expect(Object.getPrototypeOf(runtime.shipmentActivityService)).toBe(Object.prototype);
  expect(Object.isFrozen(runtime.shipmentActivityService)).toBe(true);
  expect(runtime.shipmentActivityService.listShipments).toEqual(expect.any(Function));
  expect(runtime.shipmentActivityService.listPreJobFailures).toEqual(expect.any(Function));
});

test('the runtime-bound payload function satisfies the real payload builder option contract', async () => {
  const masterData = {
    getBranch: code => ({ code }),
    getProduct: code => ({
      code,
      uqc: 'OTH',
      supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
      allowedZeroRateReason: 'VATEX-SA-HEA',
    }),
  };
  const c = composition({
    buildPayload: buildOeisPayload,
    loadMaster: jest.fn(() => masterData),
    createTaxResolver: createTaxPolicyResolver,
  });
  await createInvoiceRuntime(c.deps);
  const boundPayload = c.deps.createWorkflow.mock.calls[0][0].buildPayload;

  expect(boundPayload({
    shipmentId: 'S1',
    confirmedAt: '2026-08-10T06:30:00.000Z',
    branchCode: 'BRANCH-01',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '115.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: false,
      reasonCode: null,
      evidenceReference: 'event-standard-1',
      verifiedAt: '2026-08-09T06:30:00.000Z',
      buyerName: null,
      buyerNationalId: null,
    },
    bags: [{
      bagId: 'B1',
      productCode: 'SKU-01',
      quantity: 1,
      financialBreakup: {
        price_effective: '100.00',
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '0.00',
        value_of_good: '100.00',
        gst_tax_percentage: '15.00',
        gst_fee: '15.00',
        amount_paid: '115.00',
      },
      prices: {
        promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
      },
    }],
  }).documentNumber).toBe('VR-S1-1');
});
