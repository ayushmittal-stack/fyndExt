'use strict';

const { EinvoiceError } = require('../src/einvoice/errors');
const { createTestServer } = require('./utils/server');

const PAGE = Object.freeze({
  items: [{
    jobId: 42,
    shipmentId: 'shipment-42',
    documentNumber: 'VR-shipment-42-1',
    state: 'SUBMISSION_HELD',
    lockedAt: '2026-08-13T10:00:00.000Z',
    createdAt: '2026-08-13T09:59:58.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    version: 4,
  }],
  nextBeforeId: null,
});
const JOURNEY = Object.freeze({ schemaVersion: 1, mode: 'dry-run', job: { jobId: 42 } });
const RAW_JSON = '[{"TRAN_DOC_NO":"VR-shipment-42-1","CUST_NAME_WALKIN":"<redacted>","CUST_ADDITIONAL_ID_NO_WALKIN":"<redacted>"}]';
const FAILURE_PAGE = Object.freeze({
  items: [{
    jobId: 51,
    shipmentId: 'shipment-51',
    documentNumber: 'VR-shipment-51-1',
    state: 'DATA_FAILED',
    failureCode: 'LOCAL_VALIDATION_FAILED',
    failureMessage: 'Invoice data failed local validation.',
    attemptCount: 2,
    lockRecordedAt: null,
    createdAt: '2026-08-13T09:00:00.000Z',
    failedAt: '2026-08-13T10:00:00.000Z',
    version: 3,
  }],
  nextBeforeId: 51,
});

function service(overrides = {}) {
  return {
    listDryRuns: jest.fn().mockResolvedValue(PAGE),
    listDryRunFailures: jest.fn().mockResolvedValue(FAILURE_PAGE),
    getDryRunJourney: jest.fn().mockResolvedValue(JOURNEY),
    getDryRunRequest: jest.fn().mockResolvedValue({
      rawJson: RAW_JSON,
      filename: 'VR-shipment-42-1-oeis-diagnostic.json',
      contentType: 'application/json',
      sanitized: true,
    }),
    ...overrides,
  };
}

function expectSecurityHeaders(response) {
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.pragma).toBe('no-cache');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

function bufferParser(response, callback) {
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('authenticated dry-run read routes', () => {
  test('lists held jobs with bounded pagination using only the authenticated session company', async () => {
    const dryRunService = service();
    const server = createTestServer({ dryRunService });
    const { request } = server;

    const response = await request
      .get('/api/einvoice/dry-runs?limit=37&before_id=99')
      .set('x-company-id', 'attacker-company')
      .expect(200, PAGE);

    expectSecurityHeaders(response);
    expect(dryRunService.listDryRuns).toHaveBeenCalledWith({
      companyId: '101', limit: 37, beforeId: 99,
    });
    expect(dryRunService.getDryRunJourney).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunRequest).not.toHaveBeenCalled();
    expect(server.fdkExtension.platformApiRoutes.stack)
      .toHaveLength(server.platformStackLengthBeforeApp);
  });

  test('uses safe pagination defaults and rejects malformed values before the service', async () => {
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService });

    await request.get('/api/einvoice/dry-runs').expect(200, PAGE);
    expect(dryRunService.listDryRuns).toHaveBeenLastCalledWith({
      companyId: '101', limit: 20, beforeId: null,
    });

    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'before_id=0', 'before_id=1e2']) {
      const response = await request.get(`/api/einvoice/dry-runs?${query}`).expect(404, { success: false });
      expectSecurityHeaders(response);
    }
    expect(dryRunService.listDryRuns).toHaveBeenCalledTimes(1);
  });

  test('lists terminal failures before the parameter route using authenticated company pagination only', async () => {
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService, companyId: 202 });
    const response = await request
      .get('/api/einvoice/dry-runs/failures?limit=37&before_id=99')
      .set('x-company-id', 'attacker-company')
      .expect(200, FAILURE_PAGE);

    expectSecurityHeaders(response);
    expect(dryRunService.listDryRunFailures).toHaveBeenCalledWith({
      companyId: '202', limit: 37, beforeId: 99,
    });
    expect(dryRunService.getDryRunJourney).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunRequest).not.toHaveBeenCalled();
  });

  test('failure list rejects malformed tenant and pagination before service invocation', async () => {
    const dryRunService = service();
    const malformedTenant = createTestServer({ dryRunService, fdkSession: { company_id: '01' } });
    const tenantResponse = await malformedTenant.request.get('/api/einvoice/dry-runs/failures')
      .expect(404, { success: false });
    expectSecurityHeaders(tenantResponse);

    const valid = createTestServer({ dryRunService });
    for (const query of ['limit=0', 'limit=101', 'before_id=0', 'before_id=1e2']) {
      const response = await valid.request.get(`/api/einvoice/dry-runs/failures?${query}`)
        .expect(404, { success: false });
      expectSecurityHeaders(response);
    }
    expect(dryRunService.listDryRunFailures).not.toHaveBeenCalled();
  });

  test('failure repository errors return a fixed 500 and fixed logger arguments', async () => {
    const logger = { error: jest.fn() };
    const dryRunService = service({
      listDryRunFailures: jest.fn().mockRejectedValue(new Error('SENTINEL private repository body')),
    });
    const { request } = createTestServer({ dryRunService, logger });
    const response = await request.get('/api/einvoice/dry-runs/failures')
      .expect(500, { success: false });
    expectSecurityHeaders(response);
    expect(logger.error).toHaveBeenCalledWith(
      'Application request failed', 'APPLICATION_REQUEST_FAILED',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/SENTINEL|repository body/);
  });

  test('returns the journey only for a positive safe-integer job id', async () => {
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService });

    const response = await request.get('/api/einvoice/dry-runs/42').expect(200, JOURNEY);
    expectSecurityHeaders(response);
    expect(dryRunService.getDryRunJourney).toHaveBeenCalledWith({
      companyId: '101', jobId: 42,
    });

    for (const jobId of ['0', '-1', '1.5', '9007199254740992']) {
      await request.get(`/api/einvoice/dry-runs/${jobId}`).expect(404, { success: false });
    }
    expect(dryRunService.getDryRunJourney).toHaveBeenCalledTimes(1);
  });

  test('downloads the service-sanitized diagnostic UTF-8 bytes without router reserialization', async () => {
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService });

    const response = await request
      .get('/api/einvoice/dry-runs/42/oeis-request')
      .buffer(true)
      .parse(bufferParser)
      .expect(200);

    expectSecurityHeaders(response);
    expect(response.headers['content-type']).toMatch(/^application\/json\b/);
    expect(response.headers['content-disposition'])
      .toBe('attachment; filename="VR-shipment-42-1-oeis-diagnostic.json"');
    expect(response.body).toEqual(Buffer.from(RAW_JSON, 'utf8'));
    expect(dryRunService.getDryRunRequest).toHaveBeenCalledWith({
      companyId: '101', jobId: 42,
    });
  });

  test('accepts the service-approved identifier alphabet in a safe quoted filename', async () => {
    const dryRunService = service({
      getDryRunRequest: jest.fn().mockResolvedValue({
        rawJson: '{}',
        filename: 'branch:VR-42-oeis-diagnostic.json',
        contentType: 'application/json',
        sanitized: true,
      }),
    });
    const { request } = createTestServer({ dryRunService });

    const response = await request.get('/api/einvoice/dry-runs/42/oeis-request').expect(200);
    expect(response.headers['content-disposition'])
      .toBe('attachment; filename="branch:VR-42-oeis-diagnostic.json"');
  });

  test('foreign and unknown jobs share the same sanitized not-found response', async () => {
    const missing = new EinvoiceError('DRY_RUN_NOT_FOUND', 'private missing detail');
    const ownService = service({ getDryRunJourney: jest.fn().mockRejectedValue(missing) });
    const foreignService = service({ getDryRunJourney: jest.fn().mockRejectedValue(missing) });
    const own = createTestServer({ dryRunService: ownService });
    const foreign = createTestServer({ dryRunService: foreignService, companyId: 202 });

    const unknownResponse = await own.request.get('/api/einvoice/dry-runs/42')
      .expect(404, { success: false });
    const foreignResponse = await foreign.request.get('/api/einvoice/dry-runs/42')
      .expect(404, { success: false });

    expectSecurityHeaders(unknownResponse);
    expectSecurityHeaders(foreignResponse);
    expect(foreignService.getDryRunJourney).toHaveBeenCalledWith({
      companyId: '202', jobId: 42,
    });
    expect(unknownResponse.text).toBe(foreignResponse.text);
    expect(unknownResponse.text).not.toMatch(/private|missing|202/);
  });

  test('security headers precede FDK authentication and malformed session identity fails closed', async () => {
    const rejectedByFdk = jest.fn((req, res) => res.status(401).json({ message: 'unauthorized' }));
    const unauthenticated = createTestServer({
      dryRunService: service(), platformMiddleware: rejectedByFdk,
    });
    const response = await unauthenticated.request.get('/api/einvoice/dry-runs').expect(401);
    expectSecurityHeaders(response);

    const dryRunService = service();
    const inheritedSession = Object.create({ company_id: 101 });
    const malformed = createTestServer({
      dryRunService,
      platformMiddleware(req, res, next) {
        req.fdkSession = inheritedSession;
        next();
      },
    });
    const malformedResponse = await malformed.request.get('/api/einvoice/dry-runs')
      .expect(404, { success: false });
    expectSecurityHeaders(malformedResponse);
    expect(dryRunService.listDryRuns).not.toHaveBeenCalled();
  });

  test('normalizes numeric and canonical digit-string FDK company identities to strings', async () => {
    for (const [companyId, expected] of [
      [101, '101'],
      ['202', '202'],
      ['9007199254740992', '9007199254740992'],
    ]) {
      const dryRunService = service();
      const { request } = createTestServer({ dryRunService, companyId });

      await request.get('/api/einvoice/dry-runs').expect(200, PAGE);
      expect(dryRunService.listDryRuns).toHaveBeenCalledWith({
        companyId: expected, limit: 20, beforeId: null,
      });
    }
  });

  test('rejects malformed, unsafe, inherited, accessor, and proxy company identities safely', async () => {
    const invalidSessions = [
      null,
      { company_id: 0 },
      { company_id: -1 },
      { company_id: 1.5 },
      { company_id: Number.MAX_SAFE_INTEGER + 1 },
      { company_id: '' },
      { company_id: ' ' },
      { company_id: '0' },
      { company_id: '-1' },
      { company_id: '1.5' },
      { company_id: '01' },
      Object.create({ company_id: 101 }),
      Object.defineProperty({}, 'company_id', {
        get() { throw new Error('private accessor detail'); },
      }),
      new Proxy({}, {
        getOwnPropertyDescriptor() { throw new Error('private proxy detail'); },
      }),
      new Proxy({ company_id: 101 }, {}),
    ];

    for (const fdkSession of invalidSessions) {
      const dryRunService = service();
      const { request } = createTestServer({ dryRunService, fdkSession });
      const response = await request.get('/api/einvoice/dry-runs').expect(404, { success: false });
      expectSecurityHeaders(response);
      expect(dryRunService.listDryRuns).not.toHaveBeenCalled();
    }
  });

  test('rejects every non-GET method at the prefix before auth, parsing, or route dispatch', async () => {
    const dryRunService = service();
    const fdkHandler = jest.fn((req, res, next) => next());
    const platformMiddleware = jest.fn((req, res, next) => next());
    const { request } = createTestServer({ dryRunService, fdkHandler, platformMiddleware });
    const paths = [
      '/api/einvoice/dry-runs',
      '/api/einvoice/dry-runs/failures',
      '/api/einvoice/dry-runs/42',
      '/api/einvoice/dry-runs/42/oeis-request',
    ];

    for (const pathValue of paths) {
      for (const method of ['head', 'options', 'post', 'put', 'patch', 'delete']) {
        const response = await request[method](pathValue).expect(404);
        expectSecurityHeaders(response);
      }
    }
    expect(fdkHandler).not.toHaveBeenCalled();
    expect(platformMiddleware).not.toHaveBeenCalled();
    expect(dryRunService.listDryRuns).not.toHaveBeenCalled();
    expect(dryRunService.listDryRunFailures).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunJourney).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunRequest).not.toHaveBeenCalled();
  });

  test('applies dry-run headers before JSON parsing and the global FDK handler', async () => {
    const logger = { error: jest.fn() };
    const malformed = createTestServer({ dryRunService: service(), logger });
    const malformedResponse = await malformed.request
      .get('/api/einvoice/dry-runs')
      .set('content-type', 'application/json')
      .send('{')
      .expect(500, { success: false });
    expectSecurityHeaders(malformedResponse);

    const unauthorized = createTestServer({
      dryRunService: service(),
      fdkHandler(req, res) { res.status(401).json({ message: 'global unauthorized' }); },
    });
    const unauthorizedResponse = await unauthorized.request.get('/api/einvoice/dry-runs').expect(401);
    expectSecurityHeaders(unauthorizedResponse);

    const globalFailure = createTestServer({
      dryRunService: service(),
      logger,
      fdkHandler(req, res, next) { next(new Error('private global FDK failure')); },
    });
    const failedResponse = await globalFailure.request.get('/api/einvoice/dry-runs')
      .expect(500, { success: false });
    expectSecurityHeaders(failedResponse);

    const disabled = createTestServer({ dryRunService: null });
    const disabledResponse = await disabled.request.get('/api/einvoice/dry-runs')
      .expect(404, { success: false });
    expectSecurityHeaders(disabledResponse);
  });

  test('rejects a malformed non-GET body before JSON parsing', async () => {
    const fdkHandler = jest.fn((req, res, next) => next());
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService, fdkHandler });

    const response = await request.post('/api/einvoice/dry-runs')
      .set('content-type', 'application/json')
      .send('{')
      .expect(404, { success: false });
    expectSecurityHeaders(response);
    expect(fdkHandler).not.toHaveBeenCalled();
    expect(dryRunService.listDryRuns).not.toHaveBeenCalled();
  });

  test('POST and PUT do not exist and invoke no dry-run service method', async () => {
    const dryRunService = service();
    const { request } = createTestServer({ dryRunService });

    for (const makeCall of [
      () => request.post('/api/einvoice/dry-runs').send({}),
      () => request.put('/api/einvoice/dry-runs/42').send({}),
    ]) {
      const response = await makeCall().expect(404, { success: false });
      expectSecurityHeaders(response);
    }
    expect(dryRunService.listDryRuns).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunJourney).not.toHaveBeenCalled();
    expect(dryRunService.getDryRunRequest).not.toHaveBeenCalled();
  });

  test('invalid download metadata and service failures return fixed 500s with fixed logging', async () => {
    const logger = { error: jest.fn() };
    const rawFailure = Object.assign(new Error('token customer@example.test'), {
      code: 'PRIVATE_FAILURE',
    });
    const dryRunService = service({
      getDryRunJourney: jest.fn().mockRejectedValue(rawFailure),
      getDryRunRequest: jest.fn().mockResolvedValue({
        rawJson: '{}', filename: 'unsafe\r\nInjected: yes.json', contentType: 'application/json', sanitized: true,
      }),
    });
    const { request } = createTestServer({ dryRunService, logger });

    const failed = await request.get('/api/einvoice/dry-runs/42').expect(500, { success: false });
    const unsafe = await request.get('/api/einvoice/dry-runs/42/oeis-request')
      .expect(500, { success: false });
    expectSecurityHeaders(failed);
    expectSecurityHeaders(unsafe);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenNthCalledWith(
      1, 'Application request failed', 'APPLICATION_REQUEST_FAILED',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/token|customer|PRIVATE_FAILURE|Injected/);
  });
});
