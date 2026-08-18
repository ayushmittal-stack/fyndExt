'use strict';

const { EinvoiceError } = require('../src/einvoice/errors');
const { createTestServer } = require('./utils/server');

const RECENT_PAGE = Object.freeze({
  items: [Object.freeze({
    shipmentId: 'shipment-42',
    jobId: 42,
    documentNumber: 'VR-shipment-42-1',
    lastStage: 'JOB',
    lastAction: 'JOB_DATA_FAILED',
    lastOutcome: 'FAILURE',
    lastSafeCode: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH',
    firstOccurredAt: '2026-08-17T10:00:00.000Z',
    lastOccurredAt: '2026-08-17T10:00:01.000Z',
    version: 3,
  })],
  nextBefore: null,
});
const PRE_JOB_FAILURE_PAGE = Object.freeze({
  items: [Object.freeze({
    shipmentId: 'shipment-pre-job',
    jobId: null,
    documentNumber: null,
    lastStage: 'VALIDATION',
    lastAction: 'VALIDATION_FAILED',
    lastOutcome: 'FAILURE',
    lastSafeCode: 'LOCAL_VALIDATION_FAILED',
    firstOccurredAt: '2026-08-17T09:59:59.000Z',
    lastOccurredAt: '2026-08-17T10:00:00.000Z',
    version: 1,
  })],
  nextBefore: 'opaque_pre_job_cursor',
});
const TIMELINE_PAGE = Object.freeze({
  shipmentId: 'shipment-42',
  items: [Object.freeze({
    jobId: 42,
    documentNumber: 'VR-shipment-42-1',
    stage: 'JOB',
    action: 'JOB_DATA_FAILED',
    outcome: 'FAILURE',
    attemptNumber: 1,
    startedAt: '2026-08-17T10:00:00.000Z',
    completedAt: '2026-08-17T10:00:01.000Z',
    durationMs: 1000,
    queueDelayMs: null,
    retryDelayMs: null,
    nextAttemptAt: null,
    safeCode: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH',
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
    occurredAt: '2026-08-17T10:00:01.000Z',
  })],
  nextBefore: null,
});

function activityService(overrides = {}) {
  return {
    listShipments: jest.fn().mockResolvedValue(RECENT_PAGE),
    listPreJobFailures: jest.fn().mockResolvedValue(PRE_JOB_FAILURE_PAGE),
    getTimeline: jest.fn().mockResolvedValue(TIMELINE_PAGE),
    ...overrides,
  };
}

function expectHeaders(response) {
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.pragma).toBe('no-cache');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

describe('authenticated shipment activity routes', () => {
  test('lists recent shipments from the authenticated tenant with safe defaults', async () => {
    const shipmentActivityService = activityService();
    const server = createTestServer({ shipmentActivityService, companyId: 15862 });
    const response = await server.request
      .get('/api/einvoice/shipment-activity')
      .set('x-company-id', 'attacker-company')
      .expect(200, RECENT_PAGE);

    expectHeaders(response);
    expect(shipmentActivityService.listShipments).toHaveBeenCalledWith({
      companyId: '15862', limit: 20, before: null,
    });
    expect(server.fdkExtension.platformApiRoutes.stack)
      .toHaveLength(server.platformStackLengthBeforeApp);
  });

  test('gets a shipment timeline with a bounded limit and opaque cursor', async () => {
    const shipmentActivityService = activityService();
    const { request } = createTestServer({ shipmentActivityService, companyId: '15862' });
    const response = await request
      .get('/api/einvoice/shipment-activity/shipment-42?limit=37&before=opaque_cursor')
      .expect(200, TIMELINE_PAGE);

    expectHeaders(response);
    expect(shipmentActivityService.getTimeline).toHaveBeenCalledWith({
      companyId: '15862', shipmentId: 'shipment-42', limit: 37, before: 'opaque_cursor',
    });
  });

  test('lists pre-job failures before the shipment parameter route using only session authority', async () => {
    const shipmentActivityService = activityService();
    const { request } = createTestServer({ shipmentActivityService, companyId: 15862 });
    const response = await request
      .get('/api/einvoice/shipment-activity/pre-job-failures?limit=17&before=opaque_cursor')
      .set('x-company-id', 'attacker-company')
      .expect(200, PRE_JOB_FAILURE_PAGE);

    expectHeaders(response);
    expect(shipmentActivityService.listPreJobFailures).toHaveBeenCalledWith({
      companyId: '15862', limit: 17, before: 'opaque_cursor',
    });
    expect(shipmentActivityService.getTimeline).not.toHaveBeenCalled();
    expect(shipmentActivityService.listShipments).not.toHaveBeenCalled();
  });

  test('uses independent safe defaults and fixed errors for the pre-job failure feed', async () => {
    const shipmentActivityService = activityService();
    const valid = createTestServer({ shipmentActivityService, companyId: '15862' });
    await valid.request.get('/api/einvoice/shipment-activity/pre-job-failures')
      .expect(200, PRE_JOB_FAILURE_PAGE);
    expect(shipmentActivityService.listPreJobFailures).toHaveBeenCalledWith({
      companyId: '15862', limit: 20, before: null,
    });

    for (const path of [
      '/api/einvoice/shipment-activity/pre-job-failures?limit=0',
      '/api/einvoice/shipment-activity/pre-job-failures?unknown=1',
      '/api/einvoice/shipment-activity/pre-job-failures?before=',
    ]) {
      const response = await valid.request.get(path).expect(404, { success: false });
      expectHeaders(response);
    }

    const filteredAnchorService = activityService({
      listPreJobFailures: jest.fn().mockRejectedValue(
        new EinvoiceError('SHIPMENT_ACTIVITY_NOT_FOUND', 'private anchor detail'),
      ),
    });
    const hidden = createTestServer({ shipmentActivityService: filteredAnchorService });
    const response = await hidden.request
      .get('/api/einvoice/shipment-activity/pre-job-failures?before=opaque')
      .expect(404, { success: false });
    expectHeaders(response);
    expect(response.text).not.toMatch(/private|anchor|101/);
  });

  test('does not serialize unexpected or extra pre-job failure fields', async () => {
    const logger = { error: jest.fn() };
    const shipmentActivityService = activityService({
      listPreJobFailures: jest.fn().mockResolvedValue({
        items: [{ ...PRE_JOB_FAILURE_PAGE.items[0], companyId: 'PRIVATE_TENANT' }],
        nextBefore: null,
      }),
    });
    const { request } = createTestServer({ shipmentActivityService, logger });
    const response = await request.get('/api/einvoice/shipment-activity/pre-job-failures')
      .expect(500, { success: false });
    expectHeaders(response);
    expect(response.text).not.toContain('PRIVATE_TENANT');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE_TENANT');
  });

  test('rejects malformed and duplicate queries before service dispatch', async () => {
    const shipmentActivityService = activityService();
    const { request } = createTestServer({ shipmentActivityService });
    for (const path of [
      '/api/einvoice/shipment-activity?limit=0',
      '/api/einvoice/shipment-activity?limit=51',
      '/api/einvoice/shipment-activity?limit=01',
      '/api/einvoice/shipment-activity?limit=20&limit=21',
      '/api/einvoice/shipment-activity?unknown=1',
      '/api/einvoice/shipment-activity?before=',
      '/api/einvoice/shipment-activity/shipment-42?before=a&before=b',
      '/api/einvoice/shipment-activity/unsafe%2Fshipment',
      '/api/einvoice/shipment-activity/%E0%A4%A',
    ]) {
      const response = await request.get(path).expect(404, { success: false });
      expectHeaders(response);
    }
    expect(shipmentActivityService.listShipments).not.toHaveBeenCalled();
    expect(shipmentActivityService.listPreJobFailures).not.toHaveBeenCalled();
    expect(shipmentActivityService.getTimeline).not.toHaveBeenCalled();
  });

  test('rejects malformed sessions and cannot be overridden by x-company-id', async () => {
    const shipmentActivityService = activityService();
    const inherited = Object.create({ company_id: 15862 });
    const malformed = createTestServer({ shipmentActivityService, fdkSession: inherited });
    const response = await malformed.request
      .get('/api/einvoice/shipment-activity')
      .set('x-company-id', '15862')
      .expect(404, { success: false });
    expectHeaders(response);
    expect(shipmentActivityService.listShipments).not.toHaveBeenCalled();
    expect(shipmentActivityService.listPreJobFailures).not.toHaveBeenCalled();
  });

  test.each([
    'SHIPMENT_ACTIVITY_REQUEST_INVALID',
    'SHIPMENT_ACTIVITY_NOT_FOUND',
  ])('collapses %s to an indistinguishable fixed 404', async code => {
    const shipmentActivityService = activityService({
      getTimeline: jest.fn().mockRejectedValue(new EinvoiceError(code, 'private detail')),
    });
    const { request } = createTestServer({ shipmentActivityService });
    const response = await request.get('/api/einvoice/shipment-activity/shipment-42')
      .expect(404, { success: false });
    expectHeaders(response);
    expect(response.text).not.toMatch(/private|shipment-42|101/);
  });

  test('normalizes unexpected failures through the fixed global handler', async () => {
    const logger = { error: jest.fn() };
    const shipmentActivityService = activityService({
      listShipments: jest.fn().mockRejectedValue(
        new Error('PRIVATE_SENTINEL mongodb+srv://private.invalid'),
      ),
    });
    const { request } = createTestServer({ shipmentActivityService, logger });
    const response = await request.get('/api/einvoice/shipment-activity')
      .expect(500, { success: false });
    expectHeaders(response);
    expect(logger.error).toHaveBeenCalledWith(
      'Application request failed', 'APPLICATION_REQUEST_FAILED',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/PRIVATE_SENTINEL|private\.invalid/);
  });

  test('keeps a service URI failure on the fixed internal 500 path', async () => {
    const logger = { error: jest.fn() };
    const shipmentActivityService = activityService({
      listShipments: jest.fn().mockRejectedValue(new URIError('PRIVATE_URI_SENTINEL')),
    });
    const { request } = createTestServer({ shipmentActivityService, logger });
    const response = await request.get('/api/einvoice/shipment-activity')
      .expect(500, { success: false });
    expectHeaders(response);
    expect(logger.error).toHaveBeenCalledWith(
      'Application request failed', 'APPLICATION_REQUEST_FAILED',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE_URI_SENTINEL');
  });

  test('sets security headers before FDK authentication', async () => {
    const shipmentActivityService = activityService();
    const { request } = createTestServer({
      shipmentActivityService,
      platformMiddleware(req, res) {
        res.status(401).json({ message: 'unauthorized' });
      },
    });
    const response = await request.get('/api/einvoice/shipment-activity').expect(401);
    expectHeaders(response);
    expect(shipmentActivityService.listShipments).not.toHaveBeenCalled();
    expect(shipmentActivityService.listPreJobFailures).not.toHaveBeenCalled();
  });

  test('rejects every non-GET method before parser, FDK, or service', async () => {
    const shipmentActivityService = activityService();
    const fdkHandler = jest.fn((req, res, next) => next());
    const platformMiddleware = jest.fn((req, res, next) => next());
    const { request } = createTestServer({
      shipmentActivityService, fdkHandler, platformMiddleware,
    });
    for (const method of ['head', 'options', 'post', 'put', 'patch', 'delete']) {
      const response = await request[method]('/api/einvoice/shipment-activity')
        .set('Content-Type', 'application/json')
        .send('{ malformed')
        .expect(404);
      expectHeaders(response);
    }
    expect(fdkHandler).not.toHaveBeenCalled();
    expect(platformMiddleware).not.toHaveBeenCalled();
    expect(shipmentActivityService.listShipments).not.toHaveBeenCalled();
  });

  test('returns a header-protected 404 without auth when the service is disabled', async () => {
    const fdkHandler = jest.fn((req, res, next) => next());
    const { request } = createTestServer({ shipmentActivityService: null, fdkHandler });
    const response = await request.get('/api/einvoice/shipment-activity')
      .expect(404, { success: false });
    expectHeaders(response);
    expect(fdkHandler).not.toHaveBeenCalled();
  });

  test('rejects an unsafe service result without serializing attacker data', async () => {
    let calls = 0;
    const hostile = new Proxy({}, {
      ownKeys() { calls += 1; throw new Error('PRIVATE_RESULT_SENTINEL'); },
    });
    const logger = { error: jest.fn() };
    const shipmentActivityService = activityService({
      listShipments: jest.fn().mockResolvedValue(hostile),
    });
    const { request } = createTestServer({ shipmentActivityService, logger });
    const response = await request.get('/api/einvoice/shipment-activity')
      .expect(500, { success: false });
    expectHeaders(response);
    expect(calls).toBe(0);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE_RESULT_SENTINEL');
  });

  test('does not traverse a hostile rejected value prototype while classifying errors', async () => {
    let prototypeTrapCalls = 0;
    const hostilePrototype = new Proxy({}, {
      getPrototypeOf() {
        prototypeTrapCalls += 1;
        throw new Error('PRIVATE_PROTOTYPE_TRAP');
      },
    });
    const hostile = Object.create(hostilePrototype);
    const logger = { error: jest.fn() };
    const shipmentActivityService = activityService({
      listShipments: jest.fn().mockRejectedValue(hostile),
    });
    const { request } = createTestServer({ shipmentActivityService, logger });

    const response = await request.get('/api/einvoice/shipment-activity')
      .expect(500, { success: false });
    expectHeaders(response);
    expect(prototypeTrapCalls).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Application request failed', 'APPLICATION_REQUEST_FAILED',
    );
  });
});
