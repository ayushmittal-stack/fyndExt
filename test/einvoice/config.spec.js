'use strict';

const { loadAppConfig, loadEinvoiceConfig, loadMongoConfig } = require('../../src/einvoice/config');

const enabledConfig = {
  NODE_ENV: 'test',
  EINVOICE_ENABLED: 'true',
  EINVOICE_DRY_RUN: 'false',
  EINVOICE_MASTER_DATA_PATH: '/data/masters.json',
  OEIS_BASE_URL: 'https://oeis.example.test',
  OEIS_API_KEY: 'test-secret',
  OEIS_COMPANY_CODE: 'Viva Radix',
  OEIS_SOURCE_ERP: 'Fynd',
  OEIS_SUPPLIER_COUNTRY_CODE: 'SA',
};

test('disabled configuration does not require OEIS secrets or validate dry-run configuration', () => {
  expect(loadEinvoiceConfig({ EINVOICE_ENABLED: 'false' })).toEqual({ enabled: false });
  expect(loadEinvoiceConfig({
    EINVOICE_ENABLED: 'false',
    EINVOICE_DRY_RUN: 'true',
  })).toEqual({ enabled: false });
});

test('application configuration requires FDK credentials and webhook email', () => {
  expect(() => loadAppConfig({})).toThrow(expect.objectContaining({ code: 'CONFIG_REQUIRED' }));
});

test('application configuration requires Mongo even when e-invoicing is disabled', () => {
  expect(() => loadAppConfig({
    EINVOICE_ENABLED: 'false',
    EXTENSION_API_KEY: 'key',
    EXTENSION_API_SECRET: 'secret',
    EXTENSION_BASE_URL: 'https://extension.example.test',
    FP_API_DOMAIN: 'https://api.example.test',
    WEBHOOK_NOTIFICATION_EMAIL: 'ops@example.test',
  })).toThrow(expect.objectContaining({ code: 'CONFIG_MONGODB_URI_INVALID' }));
});

test('application configuration nests the exact frozen Mongo configuration', () => {
  const config = loadAppConfig({
    EXTENSION_API_KEY: 'key',
    EXTENSION_API_SECRET: 'secret',
    EXTENSION_BASE_URL: 'https://extension.example.test',
    FP_API_DOMAIN: 'https://api.example.test',
    WEBHOOK_NOTIFICATION_EMAIL: 'ops@example.test',
    MONGODB_URI: 'mongodb+srv://user:synthetic-secret@cluster.example/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  });

  expect(config).toEqual({
    extensionApiKey: 'key',
    extensionApiSecret: 'secret',
    extensionBaseUrl: 'https://extension.example.test',
    fpApiDomain: 'https://api.example.test',
    webhookNotificationEmail: 'ops@example.test',
    mongoConfig: {
      uri: 'mongodb+srv://user:synthetic-secret@cluster.example/?appName=SGH',
      dbName: 'sgh_oeis_einvoicing',
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    },
  });
  expect(Object.isFrozen(config.mongoConfig)).toBe(true);
  expect(config).not.toHaveProperty('fdkSessionDbPath');
});

test('application configuration rejects a proxied environment without executing traps', () => {
  const counter = { calls: 0 };
  const env = new Proxy({
    EXTENSION_API_KEY: 'key',
    EXTENSION_API_SECRET: 'synthetic-secret',
    EXTENSION_BASE_URL: 'https://extension.example.test',
    FP_API_DOMAIN: 'https://api.example.test',
    WEBHOOK_NOTIFICATION_EMAIL: 'ops@example.test',
    MONGODB_URI: 'mongodb+srv://user:synthetic-secret@cluster.example/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  }, {
    get() {
      counter.calls += 1;
      throw new Error('private application configuration detail');
    },
    getOwnPropertyDescriptor() {
      counter.calls += 1;
      throw new Error('private application configuration detail');
    },
  });

  let caught;
  try {
    loadAppConfig(env);
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({
    code: 'CONFIG_MONGODB_URI_INVALID',
    message: 'MongoDB configuration is invalid',
  }));
  expect(`${caught.message} ${caught.stack}`).not.toContain('private application');
  expect(counter.calls).toBe(0);
});

test('removed invoice environment accessors are never executed by invoice or Mongo configuration', () => {
  const invoiceEnv = { ...enabledConfig };
  const mongoEnv = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://replica.example/',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000',
  };
  let reads = 0;
  for (const env of [invoiceEnv, mongoEnv]) {
    Object.defineProperty(env, 'EINVOICE_ENV', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('removed invoice environment must stay unread');
      },
    });
  }

  expect(loadEinvoiceConfig(invoiceEnv)).not.toHaveProperty('einvoiceEnv');
  expect(loadMongoConfig(mongoEnv)).toEqual(expect.objectContaining({
    uri: 'mongodb://replica.example/',
    dbName: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000',
  }));
  expect(reads).toBe(0);
});

test('enabled configuration rejects an HTTP OEIS destination without an exact insecure opt-in', () => {
  expect(() => loadEinvoiceConfig({
    ...enabledConfig,
    OEIS_BASE_URL: 'http://oeis.invalid',
  })).toThrow(expect.objectContaining({ code: 'CONFIG_OEIS_HTTPS_REQUIRED' }));
});

test('enabled configuration permits HTTP with the exact insecure opt-in', () => {
  expect(loadEinvoiceConfig({
    ...enabledConfig,
    OEIS_BASE_URL: 'http://oeis.internal.test',
    OEIS_ALLOW_INSECURE_HTTP: 'true',
  }).baseUrl).toBe('http://oeis.internal.test');
});

test('enabled configuration requires an exact insecure HTTP opt-in', () => {
  for (const allowInsecureHttp of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true ']) {
    expect(() => loadEinvoiceConfig({
      ...enabledConfig,
      OEIS_BASE_URL: 'http://oeis.example.test',
      OEIS_ALLOW_INSECURE_HTTP: allowInsecureHttp,
    })).toThrow(expect.objectContaining({ code: 'CONFIG_OEIS_HTTPS_REQUIRED' }));
  }
});

test('enabled configuration rejects an inherited insecure HTTP opt-in', () => {
  const env = {
    ...enabledConfig,
    OEIS_BASE_URL: 'http://oeis.example.test',
  };
  Object.setPrototypeOf(env, { OEIS_ALLOW_INSECURE_HTTP: 'true' });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_HTTPS_REQUIRED',
  }));
});

test('enabled configuration rejects an accessor insecure HTTP opt-in without executing it', () => {
  const env = {
    ...enabledConfig,
    OEIS_BASE_URL: 'http://oeis.example.test',
  };
  let reads = 0;
  Object.defineProperty(env, 'OEIS_ALLOW_INSECURE_HTTP', {
    enumerable: true,
    get() {
      reads += 1;
      return 'true';
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_HTTPS_REQUIRED',
  }));
  expect(reads).toBe(0);
});

test('enabled configuration safely rejects a throwing insecure HTTP accessor without executing it', () => {
  const env = {
    ...enabledConfig,
    OEIS_BASE_URL: 'http://oeis.example.test',
  };
  let reads = 0;
  Object.defineProperty(env, 'OEIS_ALLOW_INSECURE_HTTP', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('private insecure HTTP detail');
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_HTTPS_REQUIRED',
  }));
  expect(reads).toBe(0);
});

test('enabled configuration accepts HTTPS without an invoice environment', () => {
  const config = loadEinvoiceConfig(enabledConfig);

  expect(config.baseUrl).toBe('https://oeis.example.test');
  expect(config).not.toHaveProperty('einvoiceEnv');
});

test('enabled configuration rejects an unsupported payment mode list', () => {
  expect(() => loadEinvoiceConfig({
    ...enabledConfig,
    EINVOICE_ALLOWED_PAYMENT_MODES: 'CARD,COD',
  })).toThrow(expect.objectContaining({ code: 'CONFIG_PAYMENT_MODE_INVALID' }));
});

test('enabled configuration returns approved defaults and bounded integer settings', () => {
  expect(loadEinvoiceConfig(enabledConfig)).toEqual(expect.objectContaining({
    enabled: true,
    dryRunEnabled: false,
    masterDataPath: '/data/masters.json',
    workerPollMs: 1000,
    jobLeaseMs: 30000,
    maxAttempts: 5,
    retryBaseMs: 2000,
    amountTolerance: '0.01',
    allowInsecureHttp: false,
    timeoutMs: 15000,
    maxRequestBytes: 2097152,
    maxResponseBytes: 5242880,
    companyCode: 'Viva Radix',
    sourceErp: 'Fynd',
    supplierCountryCode: 'SA',
    allowedPaymentModes: ['CARD', 'APPLE_PAY'],
  }));
  expect(loadEinvoiceConfig(enabledConfig)).not.toHaveProperty('dbPath');
  expect(loadEinvoiceConfig(enabledConfig)).not.toHaveProperty('einvoiceEnv');
});

test('enabled job lease must exceed the Mongo transaction timeout exactly', () => {
  expect(() => loadEinvoiceConfig({
    ...enabledConfig,
    EINVOICE_JOB_LEASE_MS: '5000',
  })).toThrow(expect.objectContaining({
    code: 'CONFIG_INTEGER_INVALID',
  }));
  expect(loadEinvoiceConfig({
    ...enabledConfig,
    EINVOICE_JOB_LEASE_MS: '5001',
  })).toEqual(expect.objectContaining({ jobLeaseMs: 5001 }));
});

test('disabled configuration does not inspect the unused job lease', () => {
  const env = { EINVOICE_ENABLED: 'false' };
  let reads = 0;
  Object.defineProperty(env, 'EINVOICE_JOB_LEASE_MS', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('disabled configuration must not inspect unused fields');
    },
  });

  expect(loadEinvoiceConfig(env)).toEqual({ enabled: false });
  expect(reads).toBe(0);
});

test.each([
  ['missing company code', { OEIS_COMPANY_CODE: undefined }],
  ['missing source ERP', { OEIS_SOURCE_ERP: undefined }],
  ['missing supplier country', { OEIS_SUPPLIER_COUNTRY_CODE: undefined }],
  ['stale numeric company code', { OEIS_COMPANY_CODE: '37293' }],
  ['case-changed company code', { OEIS_COMPANY_CODE: 'viva radix' }],
  ['whitespace-padded company code', { OEIS_COMPANY_CODE: 'Viva Radix ' }],
  ['stale source ERP', { OEIS_SOURCE_ERP: 'Fynd.com' }],
  ['case-changed source ERP', { OEIS_SOURCE_ERP: 'fynd' }],
  ['whitespace-padded source ERP', { OEIS_SOURCE_ERP: ' Fynd' }],
  ['case-changed supplier country', { OEIS_SUPPLIER_COUNTRY_CODE: 'sa' }],
  ['whitespace-padded supplier country', { OEIS_SUPPLIER_COUNTRY_CODE: 'SA ' }],
])('rejects enabled OEIS identity variant: %s', (_description, override) => {
  let caught;
  try {
    loadEinvoiceConfig({ ...enabledConfig, ...override });
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({
    code: 'CONFIG_OEIS_IDENTITY_INVALID',
    message: 'OEIS invoice identity configuration is invalid',
  }));
  expect(`${caught.code} ${caught.message}`).not.toMatch(/37293|viva radix|Fynd\.com/);
});

test.each(['OEIS_COMPANY_CODE', 'OEIS_SOURCE_ERP', 'OEIS_SUPPLIER_COUNTRY_CODE'])(
  'rejects inherited enabled identity field %s',
  field => {
    const env = { ...enabledConfig };
    const value = env[field];
    delete env[field];
    Object.setPrototypeOf(env, { [field]: value });

    expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
      code: 'CONFIG_OEIS_IDENTITY_INVALID',
      message: 'OEIS invoice identity configuration is invalid',
    }));
  },
);

test.each(['OEIS_COMPANY_CODE', 'OEIS_SOURCE_ERP', 'OEIS_SUPPLIER_COUNTRY_CODE'])(
  'rejects accessor enabled identity field %s without invoking it',
  field => {
    const env = { ...enabledConfig };
    const counter = { calls: 0 };
    Object.defineProperty(env, field, {
      enumerable: true,
      get() {
        counter.calls += 1;
        return enabledConfig[field];
      },
    });

    expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
      code: 'CONFIG_OEIS_IDENTITY_INVALID',
      message: 'OEIS invoice identity configuration is invalid',
    }));
    expect(counter.calls).toBe(0);
  },
);

test('rejects a proxied enabled environment before executing any trap', () => {
  const counter = { calls: 0 };
  const env = new Proxy({ ...enabledConfig }, {
    get(target, property, receiver) {
      counter.calls += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      counter.calls += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf(target) {
      counter.calls += 1;
      return Reflect.getPrototypeOf(target);
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_IDENTITY_INVALID',
    message: 'OEIS invoice identity configuration is invalid',
  }));
  expect(counter.calls).toBe(0);
});

test('rejects a callable Proxy environment before executing configuration traps', () => {
  const values = {
    EINVOICE_ENABLED: 'true',
    EINVOICE_DRY_RUN: 'false',
    OEIS_BASE_URL: 'http://oeis.internal.test',
    OEIS_ALLOW_INSECURE_HTTP: 'true',
    OEIS_API_KEY: 'synthetic-secret',
    OEIS_COMPANY_CODE: 'Viva Radix',
    OEIS_SOURCE_ERP: 'Fynd',
    OEIS_SUPPLIER_COUNTRY_CODE: 'SA',
  };
  const counter = { gets: 0, descriptors: 0 };
  const env = new Proxy(function callableEnvironment() {}, {
    get(_target, property) {
      counter.gets += 1;
      return values[property];
    },
    getOwnPropertyDescriptor(_target, property) {
      counter.descriptors += 1;
      if (!Object.prototype.hasOwnProperty.call(values, property)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: values[property],
        writable: true,
      };
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_IDENTITY_INVALID',
    message: 'OEIS invoice identity configuration is invalid',
  }));
  expect(counter).toEqual({ gets: 0, descriptors: 0 });
});

test('rejects an ordinary function environment with a fixed safe configuration error', () => {
  expect(() => loadEinvoiceConfig(function invalidEnvironment() {})).toThrow(expect.objectContaining({
    code: 'CONFIG_OEIS_IDENTITY_INVALID',
    message: 'OEIS invoice identity configuration is invalid',
  }));
});

test('enabled configuration accepts exact true and false as explicit dry-run modes', () => {
  expect(loadEinvoiceConfig({ ...enabledConfig, EINVOICE_DRY_RUN: 'true' }).dryRunEnabled)
    .toBe(true);
  expect(loadEinvoiceConfig({ ...enabledConfig, EINVOICE_DRY_RUN: 'false' }).dryRunEnabled)
    .toBe(false);
});

test('enabled configuration rejects missing, blank, and non-exact dry-run modes', () => {
  const missingMode = { ...enabledConfig };
  delete missingMode.EINVOICE_DRY_RUN;
  expect(() => loadEinvoiceConfig(missingMode)).toThrow(expect.objectContaining({
    code: 'CONFIG_DRY_RUN_INVALID',
  }));

  for (const value of ['', 'TRUE', 'False', '1', 'yes', ' true ', true, false, null, undefined]) {
    expect(() => loadEinvoiceConfig({ ...enabledConfig, EINVOICE_DRY_RUN: value }))
      .toThrow(expect.objectContaining({ code: 'CONFIG_DRY_RUN_INVALID' }));
  }
});

test('enabled configuration rejects an inherited dry-run mode', () => {
  const env = { ...enabledConfig };
  delete env.EINVOICE_DRY_RUN;
  Object.setPrototypeOf(env, { EINVOICE_DRY_RUN: 'true' });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_DRY_RUN_INVALID',
  }));
});

test('enabled configuration rejects an alternating dry-run accessor without executing it', () => {
  const env = { ...enabledConfig };
  let reads = 0;
  Object.defineProperty(env, 'EINVOICE_DRY_RUN', {
    enumerable: true,
    get() {
      reads += 1;
      return reads % 2 === 1 ? 'true' : 'false';
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_DRY_RUN_INVALID',
  }));
  expect(reads).toBe(0);
});

test('enabled configuration safely rejects a throwing dry-run accessor without executing it', () => {
  const env = { ...enabledConfig };
  let reads = 0;
  Object.defineProperty(env, 'EINVOICE_DRY_RUN', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('private dry-run detail');
    },
  });

  expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_DRY_RUN_INVALID',
  }));
  expect(reads).toBe(0);
});

test('enabled configuration keeps dry run independent of the Node runtime environment', () => {
  for (const nodeEnv of ['development', 'test', 'production', undefined]) {
    expect(loadEinvoiceConfig({
      ...enabledConfig,
      NODE_ENV: nodeEnv,
      EINVOICE_DRY_RUN: 'true',
    }).dryRunEnabled).toBe(true);
  }
});

test('enabled configuration accepts bounded OEIS byte limits and requires response capacity at least request capacity', () => {
  expect(loadEinvoiceConfig({
    ...enabledConfig,
    OEIS_MAX_REQUEST_BYTES: '1024',
    OEIS_MAX_RESPONSE_BYTES: '2048',
  })).toEqual(expect.objectContaining({ maxRequestBytes: 1024, maxResponseBytes: 2048 }));

  for (const env of [
    { OEIS_MAX_REQUEST_BYTES: '1023' },
    { OEIS_MAX_REQUEST_BYTES: '10485761' },
    { OEIS_MAX_RESPONSE_BYTES: '2047' },
    { OEIS_MAX_RESPONSE_BYTES: '20971521' },
  ]) {
    expect(() => loadEinvoiceConfig({ ...enabledConfig, ...env }))
      .toThrow(expect.objectContaining({ code: 'CONFIG_INTEGER_INVALID' }));
  }
  expect(() => loadEinvoiceConfig({
    ...enabledConfig,
    OEIS_MAX_REQUEST_BYTES: '4096',
    OEIS_MAX_RESPONSE_BYTES: '2048',
  })).toThrow(expect.objectContaining({ code: 'CONFIG_OEIS_SIZE_INVALID' }));
});

test('enabled configuration rejects empty or policy-weak retry and tolerance settings', () => {
  for (const [env, code] of [
    [{ ...enabledConfig, EINVOICE_MAX_ATTEMPTS: '' }, 'CONFIG_INTEGER_INVALID'],
    [{ ...enabledConfig, EINVOICE_MAX_ATTEMPTS: '6' }, 'CONFIG_INTEGER_INVALID'],
    [{ ...enabledConfig, EINVOICE_AMOUNT_TOLERANCE: '0.02' }, 'CONFIG_AMOUNT_TOLERANCE_INVALID'],
  ]) {
    expect(() => loadEinvoiceConfig(env)).toThrow(expect.objectContaining({ code }));
  }
});

test('configuration errors do not expose a provided secret', () => {
  expect(() => loadEinvoiceConfig({
    ...enabledConfig,
    OEIS_COMPANY_CODE: '',
  })).toThrow(expect.not.stringContaining('test-secret'));
});

test('loads an immutable Mongo configuration without mutating its environment', () => {
  const env = {
    MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  };
  const before = { ...env };

  const config = loadMongoConfig(env);

  expect(config).toEqual({
    uri: env.MONGODB_URI,
    dbName: 'sgh_oeis_einvoicing',
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  expect(Object.isFrozen(config)).toBe(true);
  expect(env).toEqual(before);
});

test.each([
  ['missing URI', { omitUri: true }, 'CONFIG_MONGODB_URI_INVALID'],
  ['blank URI', { MONGODB_URI: '   ' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['placeholder URI', { MONGODB_URI: 'mongodb+srv://user:<db_password>@cluster.example/' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['encoded placeholder URI', { MONGODB_URI: 'mongodb+srv://user:%3Cdb_password%3E@cluster.example/' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['embedded database path', { MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/another_database' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['query credentials', { MONGODB_URI: 'mongodb+srv://cluster.example/?username=user&password=secret' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['unsupported URI scheme', { MONGODB_URI: 'https://cluster.example/' }, 'CONFIG_MONGODB_URI_INVALID'],
  ['unsafe database name', { MONGODB_DB_NAME: 'sgh_oeis_einvoicing;drop' }, 'CONFIG_MONGODB_DB_NAME_INVALID'],
])('rejects Mongo configuration with %s without exposing supplied values', (_description, override, code) => {
  const env = {
    MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
    ...override,
  };
  if (env.omitUri === true) {
    delete env.omitUri;
    delete env.MONGODB_URI;
  }
  let caught;

  try {
    loadMongoConfig(env);
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({ code }));
  expect(caught.message).not.toContain(String(env.MONGODB_URI));
  expect(caught.message).not.toContain(String(env.MONGODB_DB_NAME));
});

test('rejects a non-SRV Mongo URI in production without exposing it', () => {
  const env = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://user:secret@replica.example/',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  };

  expect(() => loadMongoConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_MONGODB_URI_INVALID',
  }));
  try {
    loadMongoConfig(env);
  } catch (error) {
    expect(error.message).not.toContain(env.MONGODB_URI);
  }
});

test('allows a standard Mongo URI only for an isolated test database', () => {
  const env = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://replica.example/',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000',
  };

  expect(loadMongoConfig(env)).toEqual(expect.objectContaining({
    uri: env.MONGODB_URI,
    dbName: env.MONGODB_DB_NAME,
  }));
});

test.each([
  ['development', { NODE_ENV: 'development', MONGODB_DB_NAME: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000' }],
  ['no runtime environment', { MONGODB_DB_NAME: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000' }],
  ['production database under test', { NODE_ENV: 'test', MONGODB_DB_NAME: 'sgh_oeis_einvoicing' }],
  ['production', { NODE_ENV: 'production', MONGODB_DB_NAME: 'sgh_oeis_einvoicing_test_123e4567-e89b-12d3-a456-426614174000' }],
])('rejects a standard Mongo URI outside isolated tests: %s', (_description, override) => {
  expect(() => loadMongoConfig({
    MONGODB_URI: 'mongodb://replica.example/',
    ...override,
  })).toThrow(expect.objectContaining({ code: 'CONFIG_MONGODB_URI_INVALID' }));
});

test('accepts an SRV URI with the production database in production', () => {
  expect(loadMongoConfig({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/?appName=SGH',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  })).toEqual(expect.objectContaining({ dbName: 'sgh_oeis_einvoicing' }));
});

test.each([
  ['missing database name', env => {
    delete env.MONGODB_DB_NAME;
  }],
  ['accessor database name', env => {
    const counter = { calls: 0 };
    Object.defineProperty(env, 'MONGODB_DB_NAME', {
      enumerable: true,
      get() {
        counter.calls += 1;
        throw new Error('must not execute');
      },
    });
    return counter;
  }],
])('uses the database-name code for %s', (_description, change) => {
  const env = {
    MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  };
  const counter = change(env);

  expect(() => loadMongoConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_MONGODB_DB_NAME_INVALID',
  }));
  if (counter) expect(counter.calls).toBe(0);
});

test('rejects accessor Mongo environment values without invoking them', () => {
  const env = { MONGODB_DB_NAME: 'sgh_oeis_einvoicing' };
  const counter = { calls: 0 };
  Object.defineProperty(env, 'MONGODB_URI', {
    enumerable: true,
    get() {
      counter.calls += 1;
      return 'mongodb+srv://user:secret@cluster.example/';
    },
  });

  expect(() => loadMongoConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_MONGODB_URI_INVALID',
  }));
  expect(counter.calls).toBe(0);
});

test('rejects a proxied Mongo environment before executing its traps', () => {
  const counter = { calls: 0 };
  const env = new Proxy({
    MONGODB_URI: 'mongodb+srv://user:secret@cluster.example/',
    MONGODB_DB_NAME: 'sgh_oeis_einvoicing',
  }, {
    get(target, property, receiver) {
      counter.calls += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      counter.calls += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  expect(() => loadMongoConfig(env)).toThrow(expect.objectContaining({
    code: 'CONFIG_MONGODB_URI_INVALID',
  }));
  expect(counter.calls).toBe(0);
});
