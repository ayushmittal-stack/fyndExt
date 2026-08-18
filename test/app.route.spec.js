'use strict';

const path = require('path');

const { createApp } = require('../src/app');
const { createTestServer } = require('./utils/server');

describe('application routes and configuration', () => {
  test('the retired sample product API is absent before authenticated platform middleware', async () => {
    const platformMiddleware = jest.fn((req, res) => res.status(401).json({ message: 'unauthorized' }));
    const { request } = createTestServer({ platformMiddleware });

    await request.get('/api/products').expect(404, { success: false });
    await request
      .get('/api/products/application/000000000000000000000001')
      .expect(404, { success: false });
    expect(platformMiddleware).not.toHaveBeenCalled();
  });

  test('the SPA fallback handles GET only and the removed unsigned shipment route is absent', async () => {
    const { request } = createTestServer();

    const page = await request.get('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    await request.post('/api/webhook/shipment').send({}).expect(404, { success: false });
    await request.post('/some-client-route').expect(404);
  });

  test('removed and unknown API paths are 404 without invoking strict FDK session middleware', async () => {
    const platformMiddleware = jest.fn((req, res) => res.status(401).json({ message: 'unauthorized' }));
    const { request } = createTestServer({ platformMiddleware });

    await request.post('/api/webhook/shipment').expect(404, { success: false });
    await request.get('/api/not-a-route').expect(404, { success: false });
    expect(platformMiddleware).not.toHaveBeenCalled();
  });

  test('application options accept null but reject a partial dry-run service surface', () => {
    const valid = createTestServer({ dryRunService: null });
    expect(valid.app).toBeDefined();

    const fdkExtension = valid.fdkExtension;
    expect(() => createApp({
      fdkExtension,
      logger: { error: jest.fn() },
      staticPath: path.join(__dirname, '..', 'frontend'),
      dryRunService: {
        listDryRuns: jest.fn(), getDryRunJourney: jest.fn(), getDryRunRequest: jest.fn(),
      },
    })).toThrow(expect.objectContaining({ code: 'APP_CONFIG_INVALID' }));
  });

  test('application options reject accessor, inherited, class, array, and proxy service surfaces safely', () => {
    const valid = createTestServer({ dryRunService: null });
    const baseOptions = {
      fdkExtension: valid.fdkExtension,
      logger: { error: jest.fn() },
      staticPath: path.join(__dirname, '..', 'frontend'),
    };
    class ClassService {
      listDryRuns() {}
      listDryRunFailures() {}
      getDryRunJourney() {}
      getDryRunRequest() {}
    }
    const accessor = {
      get listDryRuns() { throw new Error('private accessor detail'); },
      listDryRunFailures: jest.fn(), getDryRunJourney: jest.fn(), getDryRunRequest: jest.fn(),
    };
    const inherited = Object.create({
      listDryRuns: jest.fn(), listDryRunFailures: jest.fn(), getDryRunJourney: jest.fn(), getDryRunRequest: jest.fn(),
    });
    const proxy = new Proxy({
      listDryRuns: jest.fn(), listDryRunFailures: jest.fn(), getDryRunJourney: jest.fn(), getDryRunRequest: jest.fn(),
    }, {
      getOwnPropertyDescriptor() { throw new Error('private proxy detail'); },
    });

    for (const dryRunService of [[], new ClassService(), accessor, inherited, proxy]) {
      expect(() => createApp({ ...baseOptions, dryRunService })).toThrow(expect.objectContaining({
        code: 'APP_CONFIG_INVALID',
        message: 'Application configuration is invalid',
      }));
    }
  });

  test('application options snapshot an exact activity service and reject hostile surfaces safely', () => {
    const valid = createTestServer({ shipmentActivityService: null });
    const baseOptions = {
      fdkExtension: valid.fdkExtension,
      logger: { error: jest.fn() },
      staticPath: path.join(__dirname, '..', 'frontend'),
      dryRunService: null,
    };
    const service = {
      listShipments: jest.fn(), listPreJobFailures: jest.fn(), getTimeline: jest.fn(),
    };
    expect(() => createApp({
      ...baseOptions, shipmentActivityService: service,
    })).not.toThrow();

    let accessorReads = 0;
    const accessor = { listPreJobFailures: jest.fn(), getTimeline: jest.fn() };
    Object.defineProperty(accessor, 'listShipments', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('private activity accessor');
      },
    });
    class ActivityService {
      constructor() { Object.assign(this, service); }
    }
    const proxy = new Proxy({ ...service }, {
      getOwnPropertyDescriptor() { throw new Error('private activity proxy'); },
    });
    for (const shipmentActivityService of [
      { listShipments: jest.fn() },
      { ...service, extra: jest.fn() },
      Object.create(service),
      Object.assign([], service),
      new ActivityService(),
      accessor,
      proxy,
    ]) {
      expect(() => createApp({
        ...baseOptions, shipmentActivityService,
      })).toThrow(expect.objectContaining({
        code: 'APP_CONFIG_INVALID',
        message: 'Application configuration is invalid',
      }));
    }
    expect(accessorReads).toBe(0);
  });

  test('application options reject an activity-service option accessor without invoking it', () => {
    const valid = createTestServer({ shipmentActivityService: null });
    let accessorReads = 0;
    const options = {
      fdkExtension: valid.fdkExtension,
      logger: { error: jest.fn() },
      staticPath: path.join(__dirname, '..', 'frontend'),
      dryRunService: null,
    };
    Object.defineProperty(options, 'shipmentActivityService', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('PRIVATE_ACTIVITY_OPTION_ACCESSOR');
      },
    });

    expect(() => createApp(options)).toThrow(expect.objectContaining({
      code: 'APP_CONFIG_INVALID',
      message: 'Application configuration is invalid',
    }));
    expect(accessorReads).toBe(0);
  });
});
