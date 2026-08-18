'use strict';

const express = require('express');
const supertest = require('supertest');
const path = require('path');

const { createApp } = require('../../src/app');

function createTestServer(options = {}) {
  const platformApiRoutes = express.Router();
  platformApiRoutes.use(options.platformMiddleware || ((req, res, next) => {
    req.fdkSession = options.fdkSession === undefined ? {
      company_id: options.companyId === undefined ? 101 : options.companyId,
    } : options.fdkSession;
    next();
  }));
  const platformStackLengthBeforeApp = platformApiRoutes.stack.length;
  const fdkExtension = {
    fdkHandler: options.fdkHandler || ((req, res, next) => next()),
    platformApiRoutes,
    webhookRegistry: {
      processWebhook: options.processWebhook || jest.fn().mockResolvedValue(undefined),
    },
  };
  const logger = options.logger || { error: jest.fn() };
  const app = createApp({
    fdkExtension,
    logger,
    staticPath: path.join(__dirname, '..', '..', 'frontend'),
    dryRunService: options.dryRunService === undefined ? null : options.dryRunService,
    shipmentActivityService: options.shipmentActivityService === undefined
      ? null
      : options.shipmentActivityService,
  });
  return {
    app,
    request: supertest(app),
    fdkExtension,
    logger,
    platformStackLengthBeforeApp,
  };
}

module.exports = { createTestServer };
