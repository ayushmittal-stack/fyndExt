'use strict';

const { createTestServer } = require('./utils/server');

describe('signed FDK webhook route', () => {
  test('passes the signed request object exactly once and awaits completion before success', async () => {
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    let entered;
    const wasEntered = new Promise(resolve => { entered = resolve; });
    const processWebhook = jest.fn().mockImplementation(() => {
      entered();
      return deferred;
    });
    const { request } = createTestServer({ processWebhook });

    const pending = request.post('/api/webhook-events').send({ secret: 'body-is-not-the-contract' });
    let settled = false;
    const responsePromise = pending.then((response) => {
      settled = true;
      return response;
    });
    await wasEntered;
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(processWebhook.mock.calls[0][0]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(processWebhook.mock.calls[0][0]).not.toBe(processWebhook.mock.calls[0][0].body);
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);

    release();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
  });

  test('returns only sanitized failure JSON and fixed allowlisted logging', async () => {
    const error = Object.assign(new Error('api-key shipment-123 customer@example.test'), {
      code: 'PRIVATE_REMOTE_FAILURE',
      response: { data: { token: 'secret-token' } },
    });
    const logger = { error: jest.fn() };
    const { request } = createTestServer({
      processWebhook: jest.fn().mockRejectedValue(error),
      logger,
    });

    await request.post('/api/webhook-events').send({ shipment_id: 'shipment-123' })
      .expect(500, { success: false });
    expect(logger.error).toHaveBeenCalledWith(
      'Webhook processing failed',
      'WEBHOOK_PROCESSING_FAILED',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/api-key|shipment-123|customer|secret-token/);
  });
});

describe('FDK extension factory', () => {
  const env = {
    EXTENSION_API_KEY: 'extension-key',
    EXTENSION_API_SECRET: 'extension-secret',
    EXTENSION_BASE_URL: 'https://extension.example.test',
    FP_API_DOMAIN: 'https://api.example.test',
    WEBHOOK_NOTIFICATION_EMAIL: 'ops@example.test',
    MONGODB_URI:
      'mongodb+srv://synthetic-user:synthetic-password@cluster.example.test/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  };

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@gofynd/fdk-extension-javascript/express');
  });

  test('calls setupFdk once with the audited options and requires initialized output', async () => {
    const setupFdk = jest.fn().mockResolvedValue({
      extension: { isInitialized: true },
      fdkHandler() {},
      platformApiRoutes() {},
      webhookRegistry: {},
    });
    jest.doMock('@gofynd/fdk-extension-javascript/express', () => ({ setupFdk }));
    const { createFdkExtension } = require('../server');
    const storage = { get() {}, set() {}, setex() {}, del() {} };
    const shipmentWebhookHandler = jest.fn();

    const result = await createFdkExtension({ env, storage, shipmentWebhookHandler });

    expect(result.extension.isInitialized).toBe(true);
    expect(setupFdk).toHaveBeenCalledTimes(1);
    const [options, syncInitialization] = setupFdk.mock.calls[0];
    expect(syncInitialization).toBe(true);
    expect(options).toEqual({
      api_key: 'extension-key',
      api_secret: 'extension-secret',
      base_url: 'https://extension.example.test',
      cluster: 'https://api.example.test',
      callbacks: {
        auth: expect.any(Function),
        uninstall: expect.any(Function),
      },
      storage,
      access_mode: 'offline',
      webhook_config: {
        api_path: '/api/webhook-events',
        notification_email: 'ops@example.test',
        event_map: {
          'application/shipment/update': {
            version: '1',
            handler: shipmentWebhookHandler,
          },
        },
      },
    });
    await expect(options.callbacks.auth({
      extension: { base_url: 'https://extension.example.test' },
      query: { company_id: '11', application_id: '22' },
    })).resolves.toBe('https://extension.example.test/company/11/application/22');
    await expect(options.callbacks.auth({
      extension: { base_url: 'https://extension.example.test' },
      query: { company_id: '11' },
    })).resolves.toBe('https://extension.example.test/company/11');
  });

  test('fails closed when setup rejects or resolves an uninitialized process-global extension', async () => {
    for (const implementation of [
      () => Promise.reject(new Error('secret initialization detail')),
      () => Promise.resolve({ extension: { isInitialized: false } }),
      () => Promise.resolve({
        extension: Object.defineProperty({}, 'isInitialized', {
          get() { throw new Error('secret getter detail'); },
        }),
      }),
    ]) {
      jest.resetModules();
      const setupFdk = jest.fn().mockImplementation(implementation);
      jest.doMock('@gofynd/fdk-extension-javascript/express', () => ({ setupFdk }));
      const { createFdkExtension } = require('../server');

      await expect(createFdkExtension({
        env,
        storage: { get() {}, set() {}, setex() {}, del() {} },
        shipmentWebhookHandler: jest.fn(),
      })).rejects.toEqual(expect.objectContaining({
        code: 'FDK_INITIALIZATION_FAILED',
        message: 'FDK extension initialization failed',
      }));
      expect(setupFdk).toHaveBeenCalledTimes(1);
    }
  });
});
