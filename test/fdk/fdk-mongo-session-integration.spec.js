'use strict';

const cookieParser = require('cookie-parser');
const express = require('express');
const path = require('path');
const request = require('supertest');
const setupFdkRoutes = require('@gofynd/fdk-extension-javascript/express/routes');
const { setupProxyRoutes } = require('@gofynd/fdk-extension-javascript/express/api_routes');
const { extension } = require('@gofynd/fdk-extension-javascript/express/extension');
const SessionStorage = require(
  '@gofynd/fdk-extension-javascript/express/session/session_storage',
);
const { ManagedMongoStorage } = require('../../src/fdk/managed-mongo-storage');
const { createApp } = require('../../src/app');
const { createMongoRepositoryHarness } = require('../utils/mongo-repository-harness');

const COMPANY_ID = 15862;
const COOKIE_SECRET = 'synthetic-fdk-install-cookie-secret';
const OAUTH_REDIRECT = 'https://accounts.example.test/oauth/authorize';

test('installed strict platform middleware returns 401 for a protected extension read without a session cookie', async () => {
  const harness = createMongoRepositoryHarness();
  const storage = new ManagedMongoStorage(harness.db);
  await storage.initialize();
  const mongoOperationsAfterInitialize = harness.trace.operations.length;
  const databaseOperationsAfterInitialize = harness.trace.databaseOperations.length;

  const original = {
    storage: extension.storage,
    webhookRegistry: extension.webhookRegistry,
  };
  const logger = { error: jest.fn() };
  const get = jest.spyOn(storage, 'get');
  extension.storage = storage;
  extension.webhookRegistry = { processWebhook: async () => undefined };
  const { platformApiRoutes } = setupProxyRoutes({});
  const app = createApp({
    fdkExtension: {
      fdkHandler: (_req, _res, next) => next(),
      platformApiRoutes,
      webhookRegistry: extension.webhookRegistry,
    },
    logger,
    staticPath: path.join(__dirname, '..', '..', 'frontend'),
    dryRunService: null,
    shipmentActivityService: {
      listShipments: jest.fn(),
      listPreJobFailures: jest.fn(),
      getTimeline: jest.fn(),
    },
  });

  try {
    await request(app)
      .get('/api/einvoice/shipment-activity')
      .set('x-company-id', String(COMPANY_ID))
      .expect(401, { message: 'unauthorized' });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(undefined);
    expect(harness.trace.operations).toHaveLength(mongoOperationsAfterInitialize);
    expect(harness.trace.databaseOperations).toHaveLength(databaseOperationsAfterInitialize);
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    Object.assign(extension, original);
    await storage.stop();
  }
});

test('installed /fp/install without redirect_path redirects and persists a retrievable Mongo session', async () => {
  const harness = createMongoRepositoryHarness();
  const storage = new ManagedMongoStorage(harness.db);
  await storage.initialize();

  const original = {
    api_key: extension.api_key,
    base_url: extension.base_url,
    callbacks: extension.callbacks,
    scopes: extension.scopes,
    storage: extension.storage,
  };
  const getPlatformConfig = jest.spyOn(extension, 'getPlatformConfig').mockResolvedValue({
    oauthClient: {
      startAuthorization: () => OAUTH_REDIRECT,
    },
  });
  Object.assign(extension, {
    api_key: 'synthetic-extension-key',
    base_url: 'https://extension.example.test',
    callbacks: {
      auth: async () => 'https://extension.example.test',
      uninstall: async () => undefined,
    },
    scopes: ['company/profile'],
    storage,
  });

  const app = express();
  app.use(cookieParser(COOKIE_SECRET));
  app.use(setupFdkRoutes(extension));
  app.use((error, _req, res, _next) => {
    res.status(500).json({ code: error.code, message: error.message });
  });

  try {
    const response = await request(app)
      .get('/fp/install')
      .query({ company_id: COMPANY_ID, install_event: 'true' });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(OAUTH_REDIRECT);

    const cookie = response.headers['set-cookie']?.find(value => (
      value.startsWith(`ext_session_${COMPANY_ID}=`)
    ));
    expect(cookie).toEqual(expect.any(String));
    const encodedValue = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
    const sessionId = cookieParser.signedCookie(decodeURIComponent(encodedValue), COOKIE_SECRET);
    expect(sessionId).toEqual(expect.any(String));

    await expect(SessionStorage.getSession(sessionId)).resolves.toEqual(expect.objectContaining({
      id: sessionId,
      company_id: COMPANY_ID,
      extension_id: 'synthetic-extension-key',
      redirect_path: null,
      isNew: false,
    }));
  } finally {
    getPlatformConfig.mockRestore();
    Object.assign(extension, original);
    await storage.stop();
  }
});
