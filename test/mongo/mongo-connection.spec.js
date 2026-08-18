'use strict';

const { openMongoConnection } = require('../../src/mongo/mongo-connection');

const config = Object.freeze({
  uri: 'mongodb+srv://user:secret@cluster.example/?appName=SGH',
  dbName: 'sgh_oeis_einvoicing',
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});

function createMongoClientClass({ failureAt, hello, failure, closeRejects = false } = {}) {
  const state = { trace: [], instances: [] };

  class FakeMongoClient {
    constructor(uri, options) {
      state.trace.push('construct');
      state.uri = uri;
      state.options = options;
      if (failureAt === 'construct') throw failure || new Error('construction failed');
      state.instances.push(this);
    }

    async connect() {
      state.trace.push('connect');
      if (failureAt === 'connect') throw failure || new Error('connect failed');
      return this;
    }

    db(name) {
      state.trace.push(`db:${name}`);
      return {
        command: async command => {
          if (command.ping === 1) {
            state.trace.push('ping');
            if (failureAt === 'ping') throw failure || new Error('ping failed');
            return { ok: 1 };
          }
          if (command.hello === 1) {
            state.trace.push('hello');
            if (failureAt === 'hello') throw failure || new Error('hello failed');
            return hello === undefined ? { logicalSessionTimeoutMinutes: 30, setName: 'replica-0' } : hello;
          }
          throw new Error('unexpected command');
        },
      };
    }

    async close() {
      state.trace.push('close');
      if (closeRejects) throw new Error('close failed');
    }
  }

  return { FakeMongoClient, state };
}

test('opens one configured client and verifies transaction-capable topology in order', async () => {
  const { FakeMongoClient, state } = createMongoClientClass();

  const connection = await openMongoConnection({
    config,
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  });

  expect(state.uri).toBe(config.uri);
  expect(state.options).toEqual({
    appName: 'sgh-oeis-einvoicing',
    serverApi: { version: '1', strict: true, deprecationErrors: true },
    retryWrites: true,
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
    promoteLongs: false,
    tls: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  expect(state.trace).toEqual([
    'construct',
    'connect',
    'db:sgh_oeis_einvoicing',
    'ping',
    'db:admin',
    'hello',
  ]);
  expect(connection.client).toBe(state.instances[0]);
  expect(Object.isFrozen(connection)).toBe(true);

  await Promise.all([connection.close(), connection.close()]);
  expect(state.trace).toEqual(expect.arrayContaining(['close']));
  expect(state.trace.filter(entry => entry === 'close')).toHaveLength(1);
});

test.each([
  ['construction', 'construct', undefined, 'MONGO_CONNECTION_FAILED'],
  ['connection', 'connect', undefined, 'MONGO_CONNECTION_FAILED'],
  ['ping', 'ping', undefined, 'MONGO_CONNECTION_FAILED'],
  ['hello command', 'hello', undefined, 'MONGO_CONNECTION_FAILED'],
  ['topology check', undefined, { logicalSessionTimeoutMinutes: 30 }, 'MONGO_TRANSACTIONS_REQUIRED'],
])('closes at most once and exposes a safe error when %s fails', async (
  _description,
  failureAt,
  hello,
  code,
) => {
  const { FakeMongoClient, state } = createMongoClientClass({ failureAt, hello });

  await expect(openMongoConnection({
    config,
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  })).rejects.toEqual(expect.objectContaining({ code }));

  expect(state.trace.filter(entry => entry === 'close')).toHaveLength(failureAt === 'construct' ? 0 : 1);
});

test('maps a forged foreign transaction code to a fresh connection error', async () => {
  const RAW_SENTINEL = 'RAW_FORGED_ERROR_SENTINEL_4f2a';
  const foreign = Object.assign(new Error(`hostile message ${RAW_SENTINEL}`), {
    code: 'MONGO_TRANSACTIONS_REQUIRED',
  });
  const { FakeMongoClient } = createMongoClientClass({ failureAt: 'hello', failure: foreign });

  let caught;
  try {
    await openMongoConnection({
      config,
      MongoClientClass: FakeMongoClient,
      serverApi: { v1: '1' },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_FAILED',
    message: 'MongoDB connection failed',
  }));
  expect(caught.cause).toBeUndefined();
  const serialized = JSON.stringify(caught);
  expect(serialized).not.toContain(RAW_SENTINEL);
  expect(caught.message).not.toContain(RAW_SENTINEL);
  expect(caught.stack).not.toContain(RAW_SENTINEL);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(caught))) {
    expect(String(descriptor.value)).not.toContain(RAW_SENTINEL);
  }
});

test('normalizes close rejection during startup failure and caller shutdown', async () => {
  const startup = createMongoClientClass({ failureAt: 'ping', closeRejects: true });
  await expect(openMongoConnection({
    config,
    MongoClientClass: startup.FakeMongoClient,
    serverApi: { v1: '1' },
  })).rejects.toEqual(expect.objectContaining({ code: 'MONGO_CONNECTION_FAILED' }));
  expect(startup.state.trace.filter(entry => entry === 'close')).toHaveLength(1);

  const caller = createMongoClientClass({ closeRejects: true });
  const connection = await openMongoConnection({
    config,
    MongoClientClass: caller.FakeMongoClient,
    serverApi: { v1: '1' },
  });
  await expect(connection.close()).rejects.toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_FAILED',
    message: 'MongoDB connection failed',
  }));
  await expect(connection.close()).rejects.toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_FAILED' }));
  expect(caller.state.trace.filter(entry => entry === 'close')).toHaveLength(1);
});

test('accepts mongos topology with logical sessions', async () => {
  const { FakeMongoClient } = createMongoClientClass({
    hello: { logicalSessionTimeoutMinutes: 30, msg: 'isdbgrid' },
  });

  await expect(openMongoConnection({
    config,
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  })).resolves.toEqual(expect.objectContaining({ client: expect.any(FakeMongoClient) }));
});

test('rejects malformed connection configuration before constructing a client', async () => {
  const { FakeMongoClient, state } = createMongoClientClass();

  await expect(openMongoConnection({
    config: { ...config, dbName: '' },
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  })).rejects.toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_FAILED',
    message: 'MongoDB connection failed',
  }));
  expect(state.trace).toEqual([]);
});

test.each([
  ['missing session', { setName: 'replica-0' }],
  ['zero session', { logicalSessionTimeoutMinutes: 0, setName: 'replica-0' }],
  ['negative session', { logicalSessionTimeoutMinutes: -1, setName: 'replica-0' }],
  ['fractional session', { logicalSessionTimeoutMinutes: 1.5, setName: 'replica-0' }],
  ['unsafe session', { logicalSessionTimeoutMinutes: Number.MAX_SAFE_INTEGER + 1, setName: 'replica-0' }],
  ['empty replica set name', { logicalSessionTimeoutMinutes: 30, setName: ' ' }],
  ['inherited topology values', Object.create({ logicalSessionTimeoutMinutes: 30, setName: 'replica-0' })],
])('rejects transaction topology with %s', async (_description, hello) => {
  const { FakeMongoClient, state } = createMongoClientClass({ hello });

  await expect(openMongoConnection({
    config,
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  })).rejects.toEqual(expect.objectContaining({ code: 'MONGO_TRANSACTIONS_REQUIRED' }));
  expect(state.trace.filter(entry => entry === 'close')).toHaveLength(1);
});

test.each([
  ['accessor hello field', () => {
    const hello = { setName: 'replica-0' };
    Object.defineProperty(hello, 'logicalSessionTimeoutMinutes', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });
    return hello;
  }],
  ['accessor inactive topology field', () => {
    const hello = { logicalSessionTimeoutMinutes: 30, setName: 'replica-0' };
    Object.defineProperty(hello, 'msg', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });
    return hello;
  }],
  ['proxied hello', () => {
    const counter = { calls: 0 };
    const hello = new Proxy({ logicalSessionTimeoutMinutes: 30, setName: 'replica-0' }, {
      get(target, property, receiver) {
        if (property !== 'then') counter.calls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        counter.calls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    return { hello, counter };
  }],
])('rejects %s without executing topology traps', async (_description, buildHello) => {
  const built = buildHello();
  const hello = built.hello || built;
  const { FakeMongoClient } = createMongoClientClass({ hello });

  await expect(openMongoConnection({
    config,
    MongoClientClass: FakeMongoClient,
    serverApi: { v1: '1' },
  })).rejects.toEqual(expect.objectContaining({ code: 'MONGO_TRANSACTIONS_REQUIRED' }));
  if (built.counter) expect(built.counter.calls).toBe(0);
});

test.each([
  ['proxied options', () => {
    const counter = { calls: 0 };
    return {
      value: new Proxy({ config, MongoClientClass: class {}, serverApi: { v1: '1' } }, {
        get(target, property, receiver) {
          counter.calls += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          counter.calls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }),
      counter,
    };
  }],
  ['accessor config', () => {
    const counter = { calls: 0 };
    const value = { MongoClientClass: class {}, serverApi: { v1: '1' } };
    Object.defineProperty(value, 'config', {
      enumerable: true,
      get() {
        counter.calls += 1;
        throw new Error('must not execute');
      },
    });
    return { value, counter };
  }],
  ['proxied config', () => {
    const counter = { calls: 0 };
    return {
      value: {
        config: new Proxy(config, {
          get(target, property, receiver) {
            counter.calls += 1;
            return Reflect.get(target, property, receiver);
          },
          getOwnPropertyDescriptor(target, property) {
            counter.calls += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        }),
        MongoClientClass: class {},
        serverApi: { v1: '1' },
      },
      counter,
    };
  }],
  ['inherited config field', () => ({
    value: Object.assign(Object.create({ config }), { MongoClientClass: class {}, serverApi: { v1: '1' } }),
  })],
])('rejects malicious %s through a fixed safe error', async (_description, buildOptions) => {
  const { value, counter } = buildOptions();

  await expect(openMongoConnection(value)).rejects.toEqual(expect.objectContaining({
    code: 'MONGO_CONNECTION_FAILED',
    message: 'MongoDB connection failed',
  }));
  if (counter) expect(counter.calls).toBe(0);
});

test('uses official driver defaults for explicit undefined injections and partial injections', async () => {
  const defaults = createMongoClientClass();
  const injected = createMongoClientClass();
  jest.doMock('mongodb', () => ({
    MongoClient: defaults.FakeMongoClient,
    ServerApiVersion: { v1: 'official-v1' },
  }));

  try {
    const cases = [
      ['both explicit undefined', undefined, undefined, defaults, 'official-v1'],
      ['client explicit undefined', undefined, { v1: 'injected-v1' }, defaults, 'injected-v1'],
      ['server API explicit undefined', injected.FakeMongoClient, undefined, injected, 'official-v1'],
    ];
    for (const [_description, MongoClientClass, serverApi, expected, expectedVersion] of cases) {
      const connection = await openMongoConnection({ config, MongoClientClass, serverApi });
      expect(connection.client).toBe(expected.state.instances.at(-1));
      expect(expected.state.options.serverApi.version).toBe(expectedVersion);
      await connection.close();
    }
  } finally {
    jest.dontMock('mongodb');
  }
});
