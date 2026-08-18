'use strict';

const { BaseStorage } = require('@gofynd/fdk-extension-javascript/express/storage');
const Session = require('@gofynd/fdk-extension-javascript/express/session/session');
const {
  ManagedMongoStorage,
  STORAGE_PREFIX,
} = require('../../src/fdk/managed-mongo-storage');

const FULL_PREFIX = 'exapmple-fynd-platform-extension:';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneDocument(document) {
  if (document === null || document === undefined) return document;
  const clone = {};
  for (const [key, value] of Object.entries(document)) {
    clone[key] = value instanceof Date ? new Date(value.getTime()) : value;
  }
  return clone;
}

function sameStoredValue(actual, expected) {
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matchesFilter(document, filter) {
  if (!document) return false;
  return Object.entries(filter).every(([key, expected]) => (
    sameStoredValue(document[key], expected)
  ));
}

function createCollectionFake() {
  const records = new Map();
  const collection = {
    close: jest.fn(),
    createIndex: jest.fn(async () => 'expiresAt_1'),
    findOne: jest.fn(async ({ _id }) => cloneDocument(records.get(_id) ?? null)),
    updateOne: jest.fn(async (filter, update, options) => {
      const existing = records.get(filter._id);
      if (!existing && !options?.upsert) {
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
          upsertedId: null,
        };
      }
      const document = existing ? cloneDocument(existing) : { _id: filter._id };
      if (!existing && update.$setOnInsert) Object.assign(document, update.$setOnInsert);
      if (update.$set) Object.assign(document, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete document[key];
      records.set(filter._id, document);
      return {
        acknowledged: true,
        matchedCount: existing ? 1 : 0,
        modifiedCount: existing ? 1 : 0,
        upsertedCount: existing ? 0 : 1,
        upsertedId: existing ? null : filter._id,
      };
    }),
    deleteOne: jest.fn(async (filter) => {
      const document = records.get(filter._id);
      if (!matchesFilter(document, filter)) {
        return { acknowledged: true, deletedCount: 0 };
      }
      records.delete(filter._id);
      return { acknowledged: true, deletedCount: 1 };
    }),
  };
  return { collection, records };
}

function createHarness({ nowMs = 10_999, options = {} } = {}) {
  const { collection, records } = createCollectionFake();
  let currentNowMs = nowMs;
  const client = { close: jest.fn() };
  const db = {
    client,
    close: jest.fn(),
    collection: jest.fn(() => collection),
  };
  const storage = new ManagedMongoStorage(db, {
    now: () => currentNowMs,
    ...options,
  });
  return {
    client,
    collection,
    db,
    records,
    storage,
    clock: {
      set(value) { currentNowMs = value; },
      advance(value) { currentNowMs += value; },
    },
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

async function expectStorageError(promise, code, message) {
  const error = await captureRejection(promise);
  expect(error).toEqual(expect.objectContaining({ code, message }));
  return error;
}

function storedDocument(valueJson, overrides = {}) {
  return {
    _id: `${FULL_PREFIX}session`,
    valueJson,
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
    ...overrides,
  };
}

function matchedUpdateResult(overrides = {}) {
  return {
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
    ...overrides,
  };
}

function upsertedUpdateResult(expectedId, overrides = {}) {
  return {
    acknowledged: true,
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 1,
    upsertedId: expectedId,
    ...overrides,
  };
}

function acknowledgedDeleteResult(deletedCount, overrides = {}) {
  return {
    acknowledged: true,
    deletedCount,
    ...overrides,
  };
}

describe('ManagedMongoStorage', () => {
  test('extends the installed BaseStorage and preserves the exact legacy prefix', () => {
    const { storage } = createHarness();

    expect(storage).toBeInstanceOf(BaseStorage);
    expect(STORAGE_PREFIX).toBe('exapmple-fynd-platform-extension');
    expect(storage.prefixKey).toBe(FULL_PREFIX);
  });

  test('initializes the exact fdk_sessions TTL index once and shares one concurrent promise', async () => {
    const { storage, db, collection } = createHarness();
    const gate = deferred();
    collection.createIndex.mockImplementationOnce(() => gate.promise);

    const first = storage.initialize();
    const second = storage.initialize();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(db.collection).toHaveBeenCalledTimes(1);
    expect(db.collection).toHaveBeenCalledWith('fdk_sessions');
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
    expect(collection.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      {
        expireAfterSeconds: 0,
        name: 'fdk_sessions_expiresAt_ttl',
      },
    );

    let finished = false;
    first.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve('expiresAt_1');
    await expect(first).resolves.toBeUndefined();
    await expect(storage.initialize()).resolves.toBeUndefined();
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
  });

  test('accepts a database whose collection method is inherited like the real Mongo Db', async () => {
    const { collection } = createCollectionFake();
    class DatabaseFake {
      collection(name) {
        expect(name).toBe('fdk_sessions');
        return collection;
      }
    }
    const storage = new ManagedMongoStorage(new DatabaseFake(), { now: () => 1_000 });

    await expect(storage.initialize()).resolves.toBeUndefined();
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
  });

  test('normalizes initialization failures without leaking raw driver data', async () => {
    const { storage, collection } = createHarness();
    collection.createIndex.mockRejectedValueOnce(Object.assign(
      new Error('raw driver token synthetic-private-value'),
      { code: 'STORAGE_DATA_INVALID' },
    ));

    const first = storage.initialize();
    const second = storage.initialize();
    const error = await expectStorageError(
      first,
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    await expect(second).rejects.toBe(error);
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw driver token|synthetic-private-value|STORAGE_DATA_INVALID/,
    );
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed database and option surfaces without executing accessors or proxy traps', () => {
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessorDb = {};
    Object.defineProperty(accessorDb, 'collection', {
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, 'now', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    const proxiedDb = new Proxy({}, {
      get() { proxyTraps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    const proxiedOptions = new Proxy({}, {
      get() { proxyTraps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    const validDb = { collection() {} };

    for (const construct of [
      () => new ManagedMongoStorage(accessorDb),
      () => new ManagedMongoStorage(proxiedDb),
      () => new ManagedMongoStorage(validDb, accessorOptions),
      () => new ManagedMongoStorage(validDb, proxiedOptions),
      () => new ManagedMongoStorage(validDb, { now: Date.now, extra: true }),
      () => new ManagedMongoStorage(validDb, { now: 123 }),
    ]) {
      expect(construct).toThrow(expect.objectContaining({
        code: 'STORAGE_CONFIG_INVALID',
        message: 'Storage configuration is invalid',
      }));
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  test('rejects an accessor collection capability during initialize without executing it', async () => {
    let getterCalls = 0;
    const collection = {};
    Object.defineProperty(collection, 'createIndex', {
      get() {
        getterCalls += 1;
        throw new Error('raw accessor secret');
      },
    });
    const db = { collection: () => collection };
    const storage = new ManagedMongoStorage(db, { now: () => 1_000 });

    await expectStorageError(
      storage.initialize(),
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    expect(getterCalls).toBe(0);
  });

  test.each([
    ['an empty string', () => ''],
    ['a whitespace-only string', () => '   '],
    ['a number', () => 1],
    ['null', () => null],
    ['a plain object', () => ({ name: 'expiresAt_1' })],
    ['an array', () => ['expiresAt_1']],
    ['a boxed string', () => new String('expiresAt_1')],
    ['a native promise fulfilled with a malformed value', () => Promise.resolve(1)],
  ])('rejects createIndex success reported as %s', async (_label, createResult) => {
    const { storage, collection } = createHarness();
    collection.createIndex.mockImplementationOnce(createResult);

    const error = await expectStorageError(
      storage.initialize(),
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    expect(error).not.toHaveProperty('cause');
  });

  test('rejects a synchronous proxied createIndex result without executing its then trap', async () => {
    const { storage, collection } = createHarness();
    let proxyTraps = 0;
    const result = new Proxy({}, {
      get(_target, key) {
        proxyTraps += 1;
        if (key === 'then') throw new Error('raw createIndex proxy synthetic-private-value');
        throw new Error('must not execute');
      },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    collection.createIndex.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.initialize(),
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    expect(proxyTraps).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw createIndex proxy|synthetic-private-value/,
    );
  });

  test('rejects an accessor createIndex then property without executing it', async () => {
    const { storage, collection } = createHarness();
    let getterCalls = 0;
    const result = {};
    Object.defineProperty(result, 'then', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('raw createIndex accessor synthetic-private-value');
      },
    });
    collection.createIndex.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.initialize(),
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    expect(getterCalls).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw createIndex accessor|synthetic-private-value/,
    );
  });

  test('rejects a synchronous thenable createIndex result without assimilating it', async () => {
    const { storage, collection } = createHarness();
    let thenCalls = 0;
    const result = {
      then(resolve) {
        thenCalls += 1;
        resolve('expiresAt_1');
      },
    };
    collection.createIndex.mockImplementationOnce(() => result);

    await expectStorageError(
      storage.initialize(),
      'STORAGE_INITIALIZATION_FAILED',
      'Storage initialization failed',
    );
    expect(thenCalls).toBe(0);
  });

  test('requires initialization before every storage operation', async () => {
    const { storage, db, collection } = createHarness();

    for (const operation of [
      () => storage.get('session'),
      () => storage.get(undefined),
      () => storage.set('session', { value: 1 }),
      () => storage.setex('session', { value: 1 }, 1),
      () => storage.del('session'),
    ]) {
      await expectStorageError(
        operation(),
        'STORAGE_NOT_INITIALIZED',
        'Storage is not initialized',
      );
    }
    expect(db.collection).not.toHaveBeenCalled();
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
    expect(collection.deleteOne).not.toHaveBeenCalled();
  });

  test('serializes a plain own-data value exactly once with the exact prefixed key and timestamps', async () => {
    const { storage, collection, records } = createHarness({ nowMs: 10_999 });
    const nested = Object.assign(Object.create(null), { tenant: 'synthetic' });
    const value = { z: 1, nested, list: [true, null, 'value'] };
    await storage.initialize();

    await expect(storage.set('offline:15862', value)).resolves.toBeUndefined();

    const fullKey = `${FULL_PREFIX}offline:15862`;
    const valueJson = '{"z":1,"nested":{"tenant":"synthetic"},"list":[true,null,"value"]}';
    expect(collection.updateOne).toHaveBeenLastCalledWith(
      { _id: fullKey },
      {
        $set: { valueJson, updatedAt: new Date(10_999) },
        $setOnInsert: { createdAt: new Date(10_999) },
        $unset: { expiresAt: '' },
      },
      { upsert: true },
    );
    expect(records.get(fullKey)).toEqual({
      _id: fullKey,
      valueJson,
      createdAt: new Date(10_999),
      updatedAt: new Date(10_999),
    });
    await expect(storage.get('offline:15862')).resolves.toEqual({
      z: 1,
      nested: { tenant: 'synthetic' },
      list: [true, null, 'value'],
    });
  });

  test('stores the real FDK install session when redirect_path is undefined', async () => {
    const { storage, records } = createHarness({ nowMs: 10_999 });
    const session = new Session('install-session');
    session.company_id = 15_862;
    session.state = 'synthetic-state';
    session.scope = ['company/products'];
    session.expires = new Date(910_999);
    session.extension_id = 'synthetic-api-key';
    session.redirect_path = undefined;
    const sessionJson = session.toJSON();
    await storage.initialize();

    expect(Object.hasOwn(sessionJson, 'redirect_path')).toBe(true);
    expect(sessionJson.redirect_path).toBeUndefined();
    await expect(storage.setex(session.id, sessionJson, 900)).resolves.toBeUndefined();

    expect(records.get(`${FULL_PREFIX}${session.id}`).valueJson).toBe(
      '{"company_id":15862,"organization_id":null,"state":"synthetic-state",'
      + '"scope":["company/products"],"expires":910999,"access_mode":"online",'
      + '"access_token":null,"current_user":null,"refresh_token":null,"expires_in":null,'
      + '"extension_id":"synthetic-api-key","access_token_validity":null}',
    );
  });

  test('stores the real FDK auth session after updateToken leaves optional fields undefined', async () => {
    const { storage, records } = createHarness({ nowMs: 10_999 });
    const session = new Session('auth-session');
    session.company_id = 15_862;
    session.state = 'synthetic-state';
    session.scope = ['company/products'];
    session.expires = new Date(3_610_999);
    session.extension_id = 'synthetic-api-key';
    session.updateToken({
      access_mode: 'online',
      access_token: 'synthetic-access-token',
      expires_in: 3_600,
      access_token_validity: 3_610_999,
    });
    const sessionJson = session.toJSON();
    await storage.initialize();

    expect(Object.hasOwn(sessionJson, 'current_user')).toBe(true);
    expect(Object.hasOwn(sessionJson, 'refresh_token')).toBe(true);
    expect(sessionJson.current_user).toBeUndefined();
    expect(sessionJson.refresh_token).toBeUndefined();
    await expect(storage.setex(session.id, sessionJson, 3_600)).resolves.toBeUndefined();

    expect(records.get(`${FULL_PREFIX}${session.id}`).valueJson).toBe(
      '{"company_id":15862,"organization_id":null,"state":"synthetic-state",'
      + '"scope":["company/products"],"expires":3610999,"access_mode":"online",'
      + '"access_token":"synthetic-access-token","expires_in":3600,'
      + '"extension_id":"synthetic-api-key","access_token_validity":3610999,'
      + '"redirect_path":null}',
    );
  });

  test('set removes an earlier expiry so the replacement remains readable after the old TTL', async () => {
    const { storage, collection, records, clock } = createHarness({ nowMs: 10_999 });
    await storage.initialize();
    await storage.setex('session', { state: 'old' }, 2);
    clock.set(11_500);

    await storage.set('session', { state: 'replacement' });
    clock.set(99_000);

    await expect(storage.get('session')).resolves.toEqual({ state: 'replacement' });
    expect(collection.updateOne.mock.calls[1][1].$unset).toEqual({ expiresAt: '' });
    expect(records.get(`${FULL_PREFIX}session`)).not.toHaveProperty('expiresAt');
  });

  test('setex floors the trusted clock to seconds and accepts the maximum TTL', async () => {
    const { storage, collection } = createHarness({ nowMs: 10_999 });
    await storage.initialize();

    await expect(storage.setex('session', { access_token: 'synthetic' }, 2_147_483_647))
      .resolves.toBeUndefined();

    expect(collection.updateOne).toHaveBeenLastCalledWith(
      { _id: `${FULL_PREFIX}session` },
      {
        $set: {
          valueJson: '{"access_token":"synthetic"}',
          expiresAt: new Date(2_147_483_657_000),
          updatedAt: new Date(10_999),
        },
        $setOnInsert: { createdAt: new Date(10_999) },
      },
      { upsert: true },
    );
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1',
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
  ])('rejects invalid TTL %p before calling Mongo', async (ttl) => {
    const { storage, collection } = createHarness();
    await storage.initialize();

    await expectStorageError(
      storage.setex('session', { value: 'synthetic' }, ttl),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('rejects an expiry that would overflow the BSON Date range', async () => {
    const { storage, collection } = createHarness({ nowMs: 8_640_000_000_000_000 });
    await storage.initialize();

    await expectStorageError(
      storage.setex('session', { value: 'synthetic' }, 1),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('treats an undefined get key as a missing FDK session without calling Mongo', async () => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    const queue = storage.queue;

    await expect(storage.get(undefined)).resolves.toBeNull();
    expect(storage.queue).toBe(queue);
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  test.each([
    ['empty', ''],
    ['leading whitespace', ' leading'],
    ['trailing whitespace', 'trailing '],
    ['a control character', 'line\nbreak'],
    ['a delete character', 'delete\u007f'],
    ['over 1024 characters', 'x'.repeat(1025)],
    ['null', null],
    ['a number', 123],
    ['an object', { id: 'session' }],
    ['an array', ['session']],
  ])('rejects a key that is %s before calling Mongo', async (_label, key) => {
    const { storage, collection } = createHarness();
    await storage.initialize();

    await expectStorageError(
      storage.get(key),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  test.each([
    ['set', storage => storage.set(undefined, { value: 'synthetic' }), 'updateOne'],
    ['setex', storage => storage.setex(undefined, { value: 'synthetic' }, 1), 'updateOne'],
    ['del', storage => storage.del(undefined), 'deleteOne'],
  ])('keeps undefined keys invalid for %s', async (_method, operation, collectionMethod) => {
    const { storage, collection } = createHarness();
    await storage.initialize();

    await expectStorageError(
      operation(storage),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection[collectionMethod]).not.toHaveBeenCalled();
  });

  test('accepts a 1024-character key and prefixes it once', async () => {
    const { storage, collection } = createHarness();
    const key = 'k'.repeat(1024);
    await storage.initialize();

    await expect(storage.get(key)).resolves.toBeNull();
    expect(collection.findOne).toHaveBeenCalledWith({ _id: `${FULL_PREFIX}${key}` });
  });

  test('rejects accessors, proxies, and inherited value data without executing attacker code', async () => {
    const { storage, collection } = createHarness();
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessorValue = {};
    Object.defineProperty(accessorValue, 'access_token', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    const inheritedValue = Object.create({
      get access_token() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    inheritedValue.safe = 'value';
    const proxiedValue = new Proxy({ safe: 'value' }, {
      get() { proxyTraps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    await storage.initialize();

    for (const value of [accessorValue, inheritedValue, proxiedValue]) {
      await expectStorageError(
        storage.set('session', value),
        'STORAGE_INPUT_INVALID',
        'Storage input is invalid',
      );
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test.each([
    ['undefined', undefined],
    ['a function', () => undefined],
    ['a bigint', 1n],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a class instance', new Date(0)],
    ['an undefined array element', [undefined]],
    ['a sparse array', [, 'value']],
  ])('rejects non-JSON plain value data containing %s', async (_label, value) => {
    const { storage, collection } = createHarness();
    await storage.initialize();

    await expectStorageError(
      storage.set('session', value),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('rejects cyclic and symbol-bearing values with a fixed input error', async () => {
    const { storage, collection } = createHarness();
    const cyclic = {};
    cyclic.self = cyclic;
    const symbolBearing = { safe: true };
    symbolBearing[Symbol('hidden')] = 'synthetic-private-value';
    await storage.initialize();

    await expectStorageError(
      storage.set('cyclic', cyclic),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    await expectStorageError(
      storage.set('symbol', symbolBearing),
      'STORAGE_INPUT_INVALID',
      'Storage input is invalid',
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('returns null at the exact logical expiry boundary and conditionally deletes the fetched version', async () => {
    const { storage, collection, clock } = createHarness({ nowMs: 10_999 });
    await storage.initialize();
    await storage.setex('offline:15862', { access_token: 'synthetic' }, 60);

    clock.set(69_999);
    await expect(storage.get('offline:15862')).resolves.toEqual({ access_token: 'synthetic' });
    expect(collection.deleteOne).not.toHaveBeenCalled();

    clock.set(70_000);
    await expect(storage.get('offline:15862')).resolves.toBeNull();
    expect(collection.deleteOne).toHaveBeenCalledWith({
      _id: `${FULL_PREFIX}offline:15862`,
      expiresAt: new Date(70_000),
      updatedAt: new Date(10_999),
    });
    expect(collection.deleteOne.mock.calls[0][0]).not.toHaveProperty('valueJson');
  });

  test('does not delete a record refreshed while an expired get is being cleaned up', async () => {
    const { storage, collection, records, clock } = createHarness({ nowMs: 10_000 });
    const fullKey = `${FULL_PREFIX}session`;
    await storage.initialize();
    await storage.setex('session', { state: 'expired' }, 1);
    clock.set(11_000);
    const defaultDelete = collection.deleteOne.getMockImplementation();
    collection.deleteOne.mockImplementationOnce(async (filter) => {
      records.set(fullKey, {
        _id: fullKey,
        valueJson: '{"state":"refreshed"}',
        createdAt: new Date(10_000),
        updatedAt: new Date(11_000),
      });
      return defaultDelete(filter);
    });

    await expect(storage.get('session')).resolves.toBeNull();
    await expect(storage.get('session')).resolves.toEqual({ state: 'refreshed' });
    expect(records.get(fullKey)).toEqual({
      _id: fullKey,
      valueJson: '{"state":"refreshed"}',
      createdAt: new Date(10_000),
      updatedAt: new Date(11_000),
    });
  });

  test('del uses the exact prefixed key and preserves void BaseStorage return semantics', async () => {
    const { storage, collection, records } = createHarness();
    await expect(storage.initialize()).resolves.toBeUndefined();
    await expect(storage.set('session', { value: true })).resolves.toBeUndefined();
    await expect(storage.setex('expiring', { value: true }, 1)).resolves.toBeUndefined();

    await expect(storage.del('session')).resolves.toBeUndefined();

    expect(collection.deleteOne).toHaveBeenLastCalledWith({ _id: `${FULL_PREFIX}session` });
    expect(records.has(`${FULL_PREFIX}session`)).toBe(false);
    await expect(storage.stop()).resolves.toBeUndefined();
  });

  test('rejects corrupt or structurally invalid returned documents with fixed data errors', async () => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    const invalidDocuments = [
      undefined,
      storedDocument('{"valid":true}', { _id: `${FULL_PREFIX}other` }),
      storedDocument(123),
      storedDocument('{"valid":true}', { createdAt: 'not-a-date' }),
      storedDocument('{"valid":true}', { expiresAt: new Date('invalid') }),
      { ...storedDocument('{"valid":true}'), unexpected: true },
      Object.assign(new (class StoredDocument {})(), storedDocument('{"valid":true}')),
    ];

    for (const document of invalidDocuments) {
      collection.findOne.mockResolvedValueOnce(document);
      await expectStorageError(
        storage.get('session'),
        'STORAGE_DATA_INVALID',
        'Storage data is invalid',
      );
    }
  });

  test('rejects returned accessor and proxy documents without executing attacker code', async () => {
    const { storage, collection } = createHarness();
    let getterCalls = 0;
    let proxyTraps = 0;
    const accessorDocument = storedDocument('{"valid":true}');
    Object.defineProperty(accessorDocument, 'valueJson', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('synthetic-private-value');
      },
    });
    const proxyDocument = new Proxy(storedDocument('{"valid":true}'), {
      get() { proxyTraps += 1; throw new Error('synthetic-private-value'); },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('synthetic-private-value'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('synthetic-private-value'); },
      ownKeys() { proxyTraps += 1; throw new Error('synthetic-private-value'); },
    });
    await storage.initialize();

    for (const document of [accessorDocument, proxyDocument]) {
      collection.findOne.mockImplementationOnce(() => document);
      await expectStorageError(
        storage.get('session'),
        'STORAGE_DATA_INVALID',
        'Storage data is invalid',
      );
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  test('maps corrupt JSON to a fixed data error without exposing stored content', async () => {
    const { storage, collection } = createHarness();
    collection.findOne.mockResolvedValueOnce(storedDocument(
      '{"access_token":"synthetic-private-value"',
    ));
    await storage.initialize();

    const error = await expectStorageError(
      storage.get('session'),
      'STORAGE_DATA_INVALID',
      'Storage data is invalid',
    );
    expect(`${error.message} ${error.stack}`).not.toMatch(/access_token|synthetic-private-value/);
  });

  test('accepts both matched update boundaries and the exact upsert result without reading unknown values', async () => {
    const { storage, collection } = createHarness();
    let unknownValueTraps = 0;
    const unknownValue = new Proxy({}, {
      get() { unknownValueTraps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor() { unknownValueTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { unknownValueTraps += 1; throw new Error('must not execute'); },
      ownKeys() { unknownValueTraps += 1; throw new Error('must not execute'); },
    });
    await storage.initialize();
    collection.updateOne
      .mockImplementationOnce(() => matchedUpdateResult({
        modifiedCount: 0,
        driverMetadata: unknownValue,
      }))
      .mockImplementationOnce(() => matchedUpdateResult({ modifiedCount: 1 }))
      .mockImplementationOnce(() => upsertedUpdateResult(`${FULL_PREFIX}third`));

    await expect(storage.set('first', { value: 1 })).resolves.toBeUndefined();
    await expect(storage.setex('second', { value: 2 }, 1)).resolves.toBeUndefined();
    await expect(storage.set('third', { value: 3 })).resolves.toBeUndefined();
    expect(unknownValueTraps).toBe(0);
  });

  test.each([
    ['null', () => null],
    ['an array', () => []],
    ['a class instance', () => Object.assign(
      new (class UpdateResult {})(),
      matchedUpdateResult(),
    )],
    ['acknowledged false', () => matchedUpdateResult({ acknowledged: false })],
    ['a non-boolean acknowledgement', () => matchedUpdateResult({ acknowledged: 1 })],
    ['missing acknowledged', () => {
      const result = matchedUpdateResult();
      delete result.acknowledged;
      return result;
    }],
    ['missing matchedCount', () => {
      const result = matchedUpdateResult();
      delete result.matchedCount;
      return result;
    }],
    ['missing modifiedCount', () => {
      const result = matchedUpdateResult();
      delete result.modifiedCount;
      return result;
    }],
    ['missing upsertedCount', () => {
      const result = matchedUpdateResult();
      delete result.upsertedCount;
      return result;
    }],
    ['missing upsertedId', () => {
      const result = matchedUpdateResult();
      delete result.upsertedId;
      return result;
    }],
    ['no match and no upsert', () => matchedUpdateResult({
      matchedCount: 0,
      modifiedCount: 0,
    })],
    ['a matched and upserted contradiction', expectedId => matchedUpdateResult({
      upsertedCount: 1,
      upsertedId: expectedId,
    })],
    ['an upsert with a modification', expectedId => upsertedUpdateResult(expectedId, {
      modifiedCount: 1,
    })],
    ['a matched result with an upserted ID', expectedId => matchedUpdateResult({
      upsertedId: expectedId,
    })],
    ['an upsert with a null ID', () => upsertedUpdateResult(null)],
    ['an upsert with the wrong ID', () => upsertedUpdateResult(`${FULL_PREFIX}other`)],
  ])('rejects updateOne result containing %s', async (_label, createResult) => {
    const { storage, collection } = createHarness();
    const expectedId = `${FULL_PREFIX}session`;
    await storage.initialize();
    collection.updateOne.mockImplementationOnce(() => createResult(expectedId));

    const error = await expectStorageError(
      storage.set('session', { value: 'synthetic' }),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(error).not.toHaveProperty('cause');
  });

  test.each([
    ['matchedCount', 'a negative value', -1],
    ['matchedCount', 'a fractional value', 1.5],
    ['matchedCount', 'an unsafe value', Number.MAX_SAFE_INTEGER + 1],
    ['matchedCount', 'a string value', '1'],
    ['matchedCount', 'a value above the updateOne maximum', 2],
    ['modifiedCount', 'a negative value', -1],
    ['modifiedCount', 'a fractional value', 0.5],
    ['modifiedCount', 'an unsafe value', Number.MAX_SAFE_INTEGER + 1],
    ['modifiedCount', 'a string value', '1'],
    ['modifiedCount', 'a value above the updateOne maximum', 2],
    ['upsertedCount', 'a negative value', -1],
    ['upsertedCount', 'a fractional value', 0.5],
    ['upsertedCount', 'an unsafe value', Number.MAX_SAFE_INTEGER + 1],
    ['upsertedCount', 'a string value', '0'],
    ['upsertedCount', 'a value above the updateOne maximum', 2],
  ])('rejects updateOne %s with %s', async (field, _label, value) => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    collection.updateOne.mockImplementationOnce(() => matchedUpdateResult({ [field]: value }));

    await expectStorageError(
      storage.set('session', { value: 'synthetic' }),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
  });

  test.each([
    ['a required field accessor', 'acknowledged'],
    ['an unknown field accessor', 'driverMetadata'],
  ])('rejects updateOne result with %s without executing it', async (_label, property) => {
    const { storage, collection } = createHarness();
    let getterCalls = 0;
    const result = matchedUpdateResult();
    Object.defineProperty(result, property, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('raw update accessor synthetic-private-value');
      },
    });
    await storage.initialize();
    collection.updateOne.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.set('session', { value: 'synthetic' }),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(getterCalls).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw update accessor|synthetic-private-value/,
    );
  });

  test('rejects a proxied updateOne result without executing its then trap', async () => {
    const { storage, collection } = createHarness();
    let proxyTraps = 0;
    const result = new Proxy(matchedUpdateResult(), {
      get(_target, key) {
        proxyTraps += 1;
        if (key === 'then') throw new Error('raw update proxy synthetic-private-value');
        throw new Error('must not execute');
      },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    await storage.initialize();
    collection.updateOne.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.set('session', { value: 'synthetic' }),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(proxyTraps).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw update proxy|synthetic-private-value/,
    );
  });

  test('setex validates its fulfilled updateOne result before resolving', async () => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    collection.updateOne.mockImplementationOnce(() => ({ acknowledged: false }));

    await expectStorageError(
      storage.setex('session', { value: 'synthetic' }, 1),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
  });

  test('accepts deleteOne counts zero and one without reading unknown values', async () => {
    const { storage, collection } = createHarness();
    let unknownValueTraps = 0;
    const unknownValue = new Proxy({}, {
      get() { unknownValueTraps += 1; throw new Error('must not execute'); },
      getOwnPropertyDescriptor() { unknownValueTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { unknownValueTraps += 1; throw new Error('must not execute'); },
      ownKeys() { unknownValueTraps += 1; throw new Error('must not execute'); },
    });
    await storage.initialize();
    collection.deleteOne
      .mockImplementationOnce(() => acknowledgedDeleteResult(0, {
        driverMetadata: unknownValue,
      }))
      .mockImplementationOnce(() => acknowledgedDeleteResult(1));

    await expect(storage.del('missing')).resolves.toBeUndefined();
    await expect(storage.del('present')).resolves.toBeUndefined();
    expect(unknownValueTraps).toBe(0);
  });

  test.each([
    ['null', () => null],
    ['an array', () => []],
    ['a class instance', () => Object.assign(
      new (class DeleteResult {})(),
      acknowledgedDeleteResult(1),
    )],
    ['acknowledged false', () => acknowledgedDeleteResult(1, { acknowledged: false })],
    ['a non-boolean acknowledgement', () => acknowledgedDeleteResult(1, { acknowledged: 1 })],
    ['missing acknowledged', () => ({ deletedCount: 1 })],
    ['missing deletedCount', () => ({ acknowledged: true })],
    ['a negative deletedCount', () => acknowledgedDeleteResult(-1)],
    ['a fractional deletedCount', () => acknowledgedDeleteResult(0.5)],
    ['an unsafe deletedCount', () => acknowledgedDeleteResult(Number.MAX_SAFE_INTEGER + 1)],
    ['a string deletedCount', () => acknowledgedDeleteResult('1')],
    ['a deletedCount above the deleteOne maximum', () => acknowledgedDeleteResult(2)],
  ])('rejects deleteOne result containing %s', async (_label, createResult) => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    collection.deleteOne.mockImplementationOnce(createResult);

    const error = await expectStorageError(
      storage.del('session'),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(error).not.toHaveProperty('cause');
  });

  test.each([
    ['a required field accessor', 'acknowledged'],
    ['an unknown field accessor', 'driverMetadata'],
  ])('rejects deleteOne result with %s without executing it', async (_label, property) => {
    const { storage, collection } = createHarness();
    let getterCalls = 0;
    const result = acknowledgedDeleteResult(1);
    Object.defineProperty(result, property, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('raw delete accessor synthetic-private-value');
      },
    });
    await storage.initialize();
    collection.deleteOne.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.del('session'),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(getterCalls).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw delete accessor|synthetic-private-value/,
    );
  });

  test('rejects a proxied deleteOne result without executing its then trap', async () => {
    const { storage, collection } = createHarness();
    let proxyTraps = 0;
    const result = new Proxy(acknowledgedDeleteResult(1), {
      get(_target, key) {
        proxyTraps += 1;
        if (key === 'then') throw new Error('raw delete proxy synthetic-private-value');
        throw new Error('must not execute');
      },
      getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('must not execute'); },
      getPrototypeOf() { proxyTraps += 1; throw new Error('must not execute'); },
      ownKeys() { proxyTraps += 1; throw new Error('must not execute'); },
    });
    await storage.initialize();
    collection.deleteOne.mockImplementationOnce(() => result);

    const error = await expectStorageError(
      storage.del('session'),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(proxyTraps).toBe(0);
    expect(error).not.toHaveProperty('cause');
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw delete proxy|synthetic-private-value/,
    );
  });

  test('expired get validates a zero-count conditional delete result before returning null', async () => {
    const { storage, collection, clock } = createHarness({ nowMs: 1_000 });
    await storage.initialize();
    await storage.setex('session', { value: 'synthetic' }, 1);
    clock.set(2_000);
    collection.deleteOne.mockImplementationOnce(() => ({ acknowledged: false }));

    await expectStorageError(
      storage.get('session'),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
  });

  test.each([
    ['findOne', storage => storage.get('session')],
    ['updateOne', storage => storage.set('session', { value: 'synthetic' })],
    ['deleteOne', storage => storage.del('session')],
  ])('normalizes %s failures to one fixed safe storage error', async (method, operation) => {
    const { storage, collection } = createHarness();
    await storage.initialize();
    collection[method].mockRejectedValueOnce(Object.assign(
      new Error('raw Mongo detail synthetic-private-value'),
      { code: 'STORAGE_DATA_INVALID' },
    ));

    const error = await expectStorageError(
      operation(storage),
      'STORAGE_OPERATION_FAILED',
      'Storage operation failed',
    );
    expect(`${error.message} ${error.stack}`).not.toMatch(
      /raw Mongo detail|synthetic-private-value|STORAGE_DATA_INVALID/,
    );
  });

  test.each([
    [() => 'not-a-number'],
    [() => -1],
    [() => Number.POSITIVE_INFINITY],
    [() => 8_640_000_000_000_001],
    [() => { throw new Error('raw clock synthetic-private-value'); }],
  ])('normalizes an invalid trusted clock without calling the write driver', async (now) => {
    const { collection } = createCollectionFake();
    const db = { collection: () => collection };
    const storage = new ManagedMongoStorage(db, { now });
    await storage.initialize();

    const error = await expectStorageError(
      storage.set('session', { value: true }),
      'STORAGE_CLOCK_INVALID',
      'Storage clock is invalid',
    );
    expect(`${error.message} ${error.stack}`).not.toMatch(/raw clock|synthetic-private-value/);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('stop rejects new work, drains all accepted operations, is idempotent, and closes no shared resource', async () => {
    const { storage, collection, db, client } = createHarness();
    const writeGate = deferred();
    collection.updateOne.mockImplementationOnce(() => writeGate.promise);
    await storage.initialize();

    const first = storage.set('one', { value: 1 });
    const second = storage.del('two');
    await Promise.resolve();
    expect(collection.updateOne).toHaveBeenCalledTimes(1);
    expect(collection.deleteOne).not.toHaveBeenCalled();

    const stopping = storage.stop();
    expect(storage.stop()).toBe(stopping);
    let stopped = false;
    stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expectStorageError(
      storage.get('three'),
      'STORAGE_STOPPED',
      'Storage is stopped',
    );
    await expectStorageError(
      storage.get(undefined),
      'STORAGE_STOPPED',
      'Storage is stopped',
    );

    writeGate.resolve(upsertedUpdateResult(`${FULL_PREFIX}one`));
    await first;
    await second;
    await expect(stopping).resolves.toBeUndefined();
    expect(collection.deleteOne).toHaveBeenCalledWith({ _id: `${FULL_PREFIX}two` });
    expect(db.close).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(collection.close).not.toHaveBeenCalled();
  });

  test('stop racing initialize waits for the one index operation and leaves the adapter stopped', async () => {
    const { storage, collection, db, client } = createHarness();
    const initializeGate = deferred();
    collection.createIndex.mockImplementationOnce(() => initializeGate.promise);

    const initializing = storage.initialize();
    await Promise.resolve();
    const stopping = storage.stop();
    let stopped = false;
    stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    initializeGate.resolve('expiresAt_1');
    await expect(initializing).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    await expectStorageError(
      storage.del('session'),
      'STORAGE_STOPPED',
      'Storage is stopped',
    );
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
    expect(db.close).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});
