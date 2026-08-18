'use strict';

const { types } = require('util');
const { EinvoiceError } = require('../einvoice/errors');

const INVALID = Symbol('invalid');

function connectionError(code) {
  return new EinvoiceError(code, code === 'MONGO_TRANSACTIONS_REQUIRED'
    ? 'MongoDB deployment does not support required transactions'
    : 'MongoDB connection failed');
}

function isPlainOwnDataObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value))
      .every(descriptor => Object.prototype.hasOwnProperty.call(descriptor, 'value'));
  } catch {
    return false;
  }
}

function ownDataValue(value, name, required = true) {
  if (!isPlainOwnDataObject(value)) return INVALID;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
  } catch {
    return INVALID;
  }
  if (descriptor === undefined) return required ? INVALID : undefined;
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return INVALID;
  return descriptor.value;
}

function suppliedValue(value, name) {
  return ownDataValue(value, name, false);
}

function readConnectionInput(input) {
  if (!isPlainOwnDataObject(input)) return INVALID;
  const config = ownDataValue(input, 'config');
  const injectedClient = suppliedValue(input, 'MongoClientClass');
  const injectedServerApi = suppliedValue(input, 'serverApi');
  if (config === INVALID || injectedClient === INVALID || injectedServerApi === INVALID) return INVALID;
  return { config, injectedClient, injectedServerApi };
}

function readConfig(config) {
  const uri = ownDataValue(config, 'uri');
  const dbName = ownDataValue(config, 'dbName');
  const serverSelectionTimeoutMS = ownDataValue(config, 'serverSelectionTimeoutMS');
  const connectTimeoutMS = ownDataValue(config, 'connectTimeoutMS');
  if (typeof uri !== 'string' || typeof dbName !== 'string' || dbName.trim() === ''
      || !Number.isSafeInteger(serverSelectionTimeoutMS) || serverSelectionTimeoutMS <= 0
      || !Number.isSafeInteger(connectTimeoutMS) || connectTimeoutMS <= 0) {
    return INVALID;
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return INVALID;
  }
  return { uri, dbName, serverSelectionTimeoutMS, connectTimeoutMS, isSrv: parsed.protocol === 'mongodb+srv:' };
}

function resolveDriver(input) {
  let { injectedClient: Client, injectedServerApi: serverApi } = input;
  if (Client === undefined || serverApi === undefined) {
    const mongodb = require('mongodb');
    Client = Client === undefined ? mongodb.MongoClient : Client;
    serverApi = serverApi === undefined ? mongodb.ServerApiVersion : serverApi;
  }
  if (typeof Client !== 'function' || types.isProxy(Client)) return INVALID;
  const version = ownDataValue(serverApi, 'v1');
  if (version === INVALID || typeof version !== 'string' || version === '') return INVALID;
  return { Client, serverApiVersion: version };
}

function supportsTransactions(hello) {
  const logicalSessionTimeoutMinutes = ownDataValue(hello, 'logicalSessionTimeoutMinutes');
  const setName = ownDataValue(hello, 'setName', false);
  const msg = ownDataValue(hello, 'msg', false);
  if (!Number.isSafeInteger(logicalSessionTimeoutMinutes) || logicalSessionTimeoutMinutes <= 0) {
    return false;
  }
  return (typeof setName === 'string' && setName.trim() !== '') || msg === 'isdbgrid';
}

async function openMongoConnection(input) {
  let client;
  let close;
  let transactionsRequired = false;
  try {
    const connectionInput = readConnectionInput(input);
    const config = connectionInput === INVALID ? INVALID : readConfig(connectionInput.config);
    const driver = connectionInput === INVALID ? INVALID : resolveDriver(connectionInput);
    if (config === INVALID || driver === INVALID) throw new Error('invalid MongoDB connection input');

    client = new driver.Client(config.uri, {
      appName: 'sgh-oeis-einvoicing',
      serverApi: { version: driver.serverApiVersion, strict: true, deprecationErrors: true },
      retryWrites: true,
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      promoteLongs: false,
      tls: config.isSrv,
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
      connectTimeoutMS: config.connectTimeoutMS,
    });

    let closePromise;
    close = () => {
      if (closePromise === undefined) {
        closePromise = Promise.resolve()
          .then(() => client.close())
          .catch(() => { throw connectionError('MONGO_CONNECTION_FAILED'); });
      }
      return closePromise;
    };

    await client.connect();
    const db = client.db(config.dbName);
    await db.command({ ping: 1 });
    const hello = await client.db('admin').command({ hello: 1 });
    if (!supportsTransactions(hello)) {
      transactionsRequired = true;
      throw new Error('transaction topology unavailable');
    }

    return Object.freeze({ client, db, close });
  } catch {
    if (close !== undefined) {
      try {
        await close();
      } catch {
        // Startup failure remains the only externally visible failure.
      }
    }
    throw connectionError(transactionsRequired ? 'MONGO_TRANSACTIONS_REQUIRED' : 'MONGO_CONNECTION_FAILED');
  }
}

module.exports = { openMongoConnection };
