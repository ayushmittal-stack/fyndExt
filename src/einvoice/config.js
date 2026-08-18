'use strict';

const { types } = require('util');
const { EinvoiceError } = require('./errors');
const {
  MONGO_TRANSACTION_TIMEOUT_MS,
} = require('./repositories/mongo-invoice-repository');

const DEFAULTS = Object.freeze({
  workerPollMs: 1000,
  jobLeaseMs: 30000,
  maxAttempts: 5,
  retryBaseMs: 2000,
  amountTolerance: '0.01',
  masterDataPath: './data/oeis-masters.json',
  timeoutMs: 15000,
  maxRequestBytes: 2_097_152,
  maxResponseBytes: 5_242_880,
});

const APPROVED_PAYMENT_MODES = Object.freeze(['CARD', 'APPLE_PAY']);
const OEIS_IDENTITY = Object.freeze({
  OEIS_COMPANY_CODE: 'Viva Radix',
  OEIS_SOURCE_ERP: 'Fynd',
  OEIS_SUPPLIER_COUNTRY_CODE: 'SA',
});

const MONGO_DB_NAME = 'sgh_oeis_einvoicing';
const MONGO_TEST_DB_NAME = /^sgh_oeis_einvoicing_test_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONGO_QUERY_CREDENTIAL_KEYS = new Set(['username', 'password']);

function oeisIdentityError() {
  return new EinvoiceError(
    'CONFIG_OEIS_IDENTITY_INVALID',
    'OEIS invoice identity configuration is invalid',
  );
}

function exactOwnIdentity(env, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    throw oeisIdentityError();
  }
  if (descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.value !== OEIS_IDENTITY[name]) {
    throw oeisIdentityError();
  }
  return descriptor.value;
}

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EinvoiceError('CONFIG_REQUIRED', `Required configuration is missing: ${name}`);
  }
  return value.trim();
}

function boundedPositiveInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw))) {
    throw new EinvoiceError('CONFIG_INTEGER_INVALID', `Configuration must be an integer: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EinvoiceError('CONFIG_INTEGER_INVALID', `Configuration is out of range: ${name}`);
  }
  return value;
}

function ownDataValue(env, name) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return undefined;
  }
  return descriptor.value;
}

function loadAppConfig(env = process.env) {
  if (env === null || typeof env !== 'object' || types.isProxy(env)) {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }
  return {
    extensionApiKey: requiredString(env, 'EXTENSION_API_KEY'),
    extensionApiSecret: requiredString(env, 'EXTENSION_API_SECRET'),
    extensionBaseUrl: requiredString(env, 'EXTENSION_BASE_URL'),
    fpApiDomain: requiredString(env, 'FP_API_DOMAIN'),
    webhookNotificationEmail: requiredString(env, 'WEBHOOK_NOTIFICATION_EMAIL'),
    mongoConfig: loadMongoConfig(env),
  };
}

function mongoConfigError(code) {
  return new EinvoiceError(code, 'MongoDB configuration is invalid');
}

function mongoOwnDataValue(env, name, errorCode) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    throw mongoConfigError(errorCode);
  }
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw mongoConfigError(errorCode);
  }
  return descriptor.value;
}

function mongoValueContainsPlaceholder(value) {
  try {
    return /[<>]/.test(decodeURIComponent(value));
  } catch {
    return true;
  }
}

function loadMongoConfig(env = process.env) {
  if (env === null || typeof env !== 'object' || types.isProxy(env)) {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }

  const uri = mongoOwnDataValue(env, 'MONGODB_URI', 'CONFIG_MONGODB_URI_INVALID');
  const dbName = mongoOwnDataValue(env, 'MONGODB_DB_NAME', 'CONFIG_MONGODB_DB_NAME_INVALID');
  const nodeEnv = Object.prototype.hasOwnProperty.call(env, 'NODE_ENV')
    ? mongoOwnDataValue(env, 'NODE_ENV', 'CONFIG_MONGODB_URI_INVALID')
    : undefined;

  if (typeof uri !== 'string' || uri.trim() === '' || uri !== uri.trim() || mongoValueContainsPlaceholder(uri)) {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)
      || parsed.pathname !== '/'
      || parsed.hash
      || mongoValueContainsPlaceholder(parsed.username)
      || mongoValueContainsPlaceholder(parsed.password)
      || [...parsed.searchParams.keys()].some(key => MONGO_QUERY_CREDENTIAL_KEYS.has(key.toLowerCase()))) {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }
  const isolatedTest = nodeEnv === 'test'
    && typeof dbName === 'string'
    && MONGO_TEST_DB_NAME.test(dbName);
  if (parsed.protocol === 'mongodb:' && !isolatedTest) {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'mongodb+srv:') {
    throw mongoConfigError('CONFIG_MONGODB_URI_INVALID');
  }
  if (typeof dbName !== 'string' || (dbName !== MONGO_DB_NAME && !isolatedTest)) {
    throw mongoConfigError('CONFIG_MONGODB_DB_NAME_INVALID');
  }

  return Object.freeze({
    uri,
    dbName,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
}

function parseOeisBaseUrl(env) {
  const value = requiredString(env, 'OEIS_BASE_URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new EinvoiceError('CONFIG_OEIS_URL_INVALID', 'OEIS base URL must be a valid HTTP(S) URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EinvoiceError('CONFIG_OEIS_URL_INVALID', 'OEIS base URL must be a plain HTTP(S) endpoint');
  }

  const allowInsecureHttp = ownDataValue(env, 'OEIS_ALLOW_INSECURE_HTTP') === 'true';
  if (parsed.protocol !== 'https:' && !allowInsecureHttp) {
    throw new EinvoiceError('CONFIG_OEIS_HTTPS_REQUIRED', 'OEIS base URL must use HTTPS');
  }

  return { baseUrl: value.replace(/\/$/, ''), allowInsecureHttp };
}

function loadEinvoiceConfig(env = process.env) {
  const envType = typeof env;
  if (env === null || (envType !== 'object' && envType !== 'function')) {
    throw oeisIdentityError();
  }
  if (types.isProxy(env) || envType !== 'object') {
    throw oeisIdentityError();
  }
  if (env.EINVOICE_ENABLED !== 'true') return { enabled: false };

  const dryRun = ownDataValue(env, 'EINVOICE_DRY_RUN');
  if (dryRun !== 'true' && dryRun !== 'false') {
    throw new EinvoiceError(
      'CONFIG_DRY_RUN_INVALID',
      'E-invoice dry run must be explicitly true or false',
    );
  }
  const dryRunEnabled = dryRun === 'true';
  const { baseUrl, allowInsecureHttp } = parseOeisBaseUrl(env);
  const companyCode = exactOwnIdentity(env, 'OEIS_COMPANY_CODE');
  const sourceErp = exactOwnIdentity(env, 'OEIS_SOURCE_ERP');
  const supplierCountryCode = exactOwnIdentity(env, 'OEIS_SUPPLIER_COUNTRY_CODE');

  if (env.EINVOICE_ALLOWED_PAYMENT_MODES !== undefined
      && env.EINVOICE_ALLOWED_PAYMENT_MODES !== APPROVED_PAYMENT_MODES.join(',')) {
    throw new EinvoiceError('CONFIG_PAYMENT_MODE_INVALID', 'Only approved prepaid payment modes are supported');
  }

  const maxRequestBytes = boundedPositiveInteger(
    env,
    'OEIS_MAX_REQUEST_BYTES',
    DEFAULTS.maxRequestBytes,
    1024,
    10 * 1024 * 1024,
  );
  const maxResponseBytes = boundedPositiveInteger(
    env,
    'OEIS_MAX_RESPONSE_BYTES',
    DEFAULTS.maxResponseBytes,
    2048,
    20 * 1024 * 1024,
  );
  if (maxResponseBytes < maxRequestBytes) {
    throw new EinvoiceError(
      'CONFIG_OEIS_SIZE_INVALID',
      'OEIS response size limit must not be smaller than the request size limit',
    );
  }

  return {
    enabled: true,
    dryRunEnabled,
    workerPollMs: boundedPositiveInteger(env, 'EINVOICE_WORKER_POLL_MS', DEFAULTS.workerPollMs, 100, 60000),
    jobLeaseMs: boundedPositiveInteger(
      env,
      'EINVOICE_JOB_LEASE_MS',
      DEFAULTS.jobLeaseMs,
      MONGO_TRANSACTION_TIMEOUT_MS + 1,
      3600000,
    ),
    maxAttempts: boundedPositiveInteger(env, 'EINVOICE_MAX_ATTEMPTS', DEFAULTS.maxAttempts, 1, 5),
    retryBaseMs: boundedPositiveInteger(env, 'EINVOICE_RETRY_BASE_MS', DEFAULTS.retryBaseMs, 100, 3600000),
    amountTolerance: env.EINVOICE_AMOUNT_TOLERANCE === undefined
      ? DEFAULTS.amountTolerance
      : parseAmountTolerance(env.EINVOICE_AMOUNT_TOLERANCE),
    masterDataPath: env.EINVOICE_MASTER_DATA_PATH === undefined
      ? DEFAULTS.masterDataPath
      : requiredString(env, 'EINVOICE_MASTER_DATA_PATH'),
    baseUrl,
    apiKey: requiredString(env, 'OEIS_API_KEY'),
    allowInsecureHttp,
    timeoutMs: boundedPositiveInteger(env, 'OEIS_TIMEOUT_MS', DEFAULTS.timeoutMs, 1000, 120000),
    maxRequestBytes,
    maxResponseBytes,
    companyCode,
    sourceErp,
    supplierCountryCode,
    currency: 'SAR',
    allowedPaymentModes: [...APPROVED_PAYMENT_MODES],
  };
}

function parseAmountTolerance(value) {
  if (String(value) !== '0.01') {
    throw new EinvoiceError('CONFIG_AMOUNT_TOLERANCE_INVALID', 'Amount tolerance must be exactly 0.01 SAR');
  }
  return '0.01';
}

module.exports = { loadAppConfig, loadEinvoiceConfig, loadMongoConfig };
