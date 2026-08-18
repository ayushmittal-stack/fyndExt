'use strict';

const { setupFdk } = require('@gofynd/fdk-extension-javascript/express');
const { loadAppConfig } = require('./src/einvoice/config');

function fdkInitializationError() {
  const error = new Error('FDK extension initialization failed');
  error.code = 'FDK_INITIALIZATION_FAILED';
  return error;
}

function validStorage(storage) {
  return storage && typeof storage === 'object'
    && ['get', 'set', 'setex', 'del'].every(method => typeof storage[method] === 'function');
}

async function createFdkExtension({ env = process.env, storage, shipmentWebhookHandler } = {}) {
  const config = loadAppConfig(env);
  let injectedSurfacesValid;
  try {
    injectedSurfacesValid = validStorage(storage) && typeof shipmentWebhookHandler === 'function';
  } catch {
    injectedSurfacesValid = false;
  }
  if (!injectedSurfacesValid) {
    throw fdkInitializationError();
  }

  const options = {
    api_key: config.extensionApiKey,
    api_secret: config.extensionApiSecret,
    base_url: config.extensionBaseUrl,
    cluster: config.fpApiDomain,
    callbacks: {
      auth: async (req) => {
        if (req.query.application_id) {
          return `${req.extension.base_url}/company/${req.query.company_id}/application/${req.query.application_id}`;
        }
        return `${req.extension.base_url}/company/${req.query.company_id}`;
      },
      uninstall: async () => undefined,
    },
    storage,
    access_mode: 'offline',
    webhook_config: {
      api_path: '/api/webhook-events',
      notification_email: config.webhookNotificationEmail,
      event_map: {
        'application/shipment/update': {
          version: '1',
          handler: shipmentWebhookHandler,
        },
      },
    },
  };

  let result;
  try {
    result = await setupFdk(options, true);
    if (!result || !result.extension || result.extension.isInitialized !== true) {
      throw fdkInitializationError();
    }
  } catch {
    throw fdkInitializationError();
  }
  return result;
}

module.exports = { createFdkExtension };
