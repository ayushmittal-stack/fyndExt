'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const serveStatic = require('serve-static');
const { types } = require('util');
const {
  createDryRunRouter,
  dryRunSecurityHeaders,
  dryRunGetOnly,
} = require('./einvoice/routes/dry-run-router');
const {
  createShipmentActivityRouter,
  shipmentActivitySecurityHeaders,
  shipmentActivityGetOnly,
  shipmentActivityDisabled,
} = require('./einvoice/routes/shipment-activity-router');

function isMiddleware(value) {
  return typeof value === 'function';
}

function invalidConfiguration() {
  const error = new Error('Application configuration is invalid');
  error.code = 'APP_CONFIG_INVALID';
  return error;
}

function snapshotDryRunService(value) {
  if (value === null) return null;
  try {
    if (typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidConfiguration();
    }
    const snapshot = {};
    for (const field of [
      'listDryRuns', 'listDryRunFailures', 'getDryRunJourney', 'getDryRunRequest',
      'getDryRunPodCurl',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function') {
        throw invalidConfiguration();
      }
      snapshot[field] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalidConfiguration();
  }
}

function snapshotShipmentActivityService(value) {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidConfiguration();
    }
    const keys = Reflect.ownKeys(value);
    const fields = ['listShipments', 'listPreJobFailures', 'getTimeline'];
    if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
      throw invalidConfiguration();
    }
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) {
        throw invalidConfiguration();
      }
      snapshot[field] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalidConfiguration();
  }
}

function snapshotAppOptions(options) {
  const fields = [
    'fdkExtension', 'logger', 'staticPath', 'dryRunService', 'shipmentActivityService',
  ];
  try {
    if (options === null || typeof options !== 'object' || types.isProxy(options)
        || Object.getPrototypeOf(options) !== Object.prototype) {
      throw invalidConfiguration();
    }
    const keys = Reflect.ownKeys(options);
    if (keys.some(key => typeof key !== 'string' || !fields.includes(key))) {
      throw invalidConfiguration();
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const values = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined) {
        values[field] = undefined;
      } else if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) {
        throw invalidConfiguration();
      } else {
        values[field] = descriptor.value;
      }
    }
    return values;
  } catch {
    throw invalidConfiguration();
  }
}

function validateOptions(options) {
  let fdkExtension;
  let logger;
  let staticPath;
  let dryRunService;
  let shipmentActivityService;
  try {
    const values = snapshotAppOptions(options);
    ({ fdkExtension, logger, staticPath } = values);
    dryRunService = snapshotDryRunService(values.dryRunService);
    shipmentActivityService = snapshotShipmentActivityService(values.shipmentActivityService);
  } catch {
    throw invalidConfiguration();
  }
  if (!fdkExtension || typeof fdkExtension !== 'object'
      || !isMiddleware(fdkExtension.fdkHandler)
      || !isMiddleware(fdkExtension.platformApiRoutes)
      || !fdkExtension.webhookRegistry
      || typeof fdkExtension.webhookRegistry.processWebhook !== 'function'
      || !logger || typeof logger !== 'object' || typeof logger.error !== 'function'
      || typeof staticPath !== 'string' || staticPath.trim() === '') {
    throw invalidConfiguration();
  }
  return {
    fdkExtension, logger, staticPath, dryRunService, shipmentActivityService,
  };
}

function createApp(options) {
  const {
    fdkExtension, logger, staticPath, dryRunService, shipmentActivityService,
  } = validateOptions(options);
  const app = express();

  app.use(
    '/api/einvoice/shipment-activity',
    shipmentActivitySecurityHeaders,
    shipmentActivityGetOnly,
  );
  if (shipmentActivityService === null) {
    app.use('/api/einvoice/shipment-activity', shipmentActivityDisabled);
  }
  app.use('/api/einvoice/dry-runs', dryRunSecurityHeaders, dryRunGetOnly);
  app.use(cookieParser('ext.session'));
  app.use(express.json({ limit: '2mb' }));
  app.use('/', fdkExtension.fdkHandler);

  app.post('/api/webhook-events', async (req, res) => {
    try {
      await fdkExtension.webhookRegistry.processWebhook(req);
      return res.status(200).json({ success: true });
    } catch {
      logger.error('Webhook processing failed', 'WEBHOOK_PROCESSING_FAILED');
      return res.status(500).json({ success: false });
    }
  });

  app.post('/api/webhook/shipment', (req, res) => res.status(404).json({ success: false }));
  if (shipmentActivityService !== null) {
    app.use(
      '/api/einvoice/shipment-activity',
      fdkExtension.platformApiRoutes,
      createShipmentActivityRouter({ shipmentActivityService }),
    );
  }
  if (dryRunService !== null) {
    app.use(
      '/api/einvoice/dry-runs',
      fdkExtension.platformApiRoutes,
      createDryRunRouter({ dryRunService }),
    );
  }
  app.use('/api', (req, res) => res.status(404).json({ success: false }));

  app.use(serveStatic(staticPath, { index: false }));
  app.get('*', (req, res, next) => {
    res.sendFile(path.join(path.resolve(staticPath), 'index.html'), (error) => {
      if (error) next(error);
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    logger.error('Application request failed', 'APPLICATION_REQUEST_FAILED');
    return res.status(500).json({ success: false });
  });

  return app;
}

module.exports = { createApp };
