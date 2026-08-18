'use strict';

const { types: { isPromise, isProxy } } = require('node:util');
const { BaseStorage } = require('@gofynd/fdk-extension-javascript/express/storage');

const STORAGE_PREFIX = 'exapmple-fynd-platform-extension';
const COLLECTION_NAME = 'fdk_sessions';
const MAX_KEY_LENGTH = 1024;
const MAX_TTL_SECONDS = 2_147_483_647;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const COLLECTION_METHODS = Object.freeze([
  'createIndex',
  'findOne',
  'updateOne',
  'deleteOne',
]);

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configError() {
  return storageError('STORAGE_CONFIG_INVALID', 'Storage configuration is invalid');
}

function inputError() {
  return storageError('STORAGE_INPUT_INVALID', 'Storage input is invalid');
}

function dataError() {
  return storageError('STORAGE_DATA_INVALID', 'Storage data is invalid');
}

function clockError() {
  return storageError('STORAGE_CLOCK_INVALID', 'Storage clock is invalid');
}

function operationError() {
  return storageError('STORAGE_OPERATION_FAILED', 'Storage operation failed');
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function plainObjectDescriptors(value) {
  if (!isObject(value) || isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null;
      }
      descriptors[key] = descriptor;
    }
    return { keys, descriptors };
  } catch {
    return null;
  }
}

function callableDataProperty(target, property) {
  if (!isObject(target) || isProxy(target)) return null;
  try {
    let current = target;
    while (current !== null) {
      if (isProxy(current)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value')
            || typeof descriptor.value !== 'function'
            || isProxy(descriptor.value)) {
          return null;
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function validateOptions(options) {
  const shape = plainObjectDescriptors(options);
  if (!shape || shape.keys.some(key => key !== 'now')) throw configError();
  const descriptor = shape.descriptors.now;
  const now = descriptor && descriptor.value !== undefined ? descriptor.value : Date.now;
  if (typeof now !== 'function' || isProxy(now)) throw configError();
  return now;
}

function validateJsonValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw inputError();
    return;
  }
  if (!isObject(value) || isProxy(value)) throw inputError();
  if (ancestors.has(value)) throw inputError();

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw inputError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || keys.some(key => typeof key !== 'string')) {
        throw inputError();
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) throw inputError();
      const elementKeys = keys.filter(key => key !== 'length');
      if (elementKeys.length !== lengthDescriptor.value) throw inputError();
      for (let index = 0; index < elementKeys.length; index += 1) {
        const key = elementKeys[index];
        if (key !== String(index)) throw inputError();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          throw inputError();
        }
        validateJsonValue(descriptor.value, ancestors);
      }
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) throw inputError();
    for (const key of keys) {
      if (typeof key !== 'string') throw inputError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw inputError();
      }
      if (descriptor.value === undefined) continue;
      validateJsonValue(descriptor.value, ancestors);
    }
  } catch {
    throw inputError();
  } finally {
    ancestors.delete(value);
  }
}

function serializeValue(value) {
  try {
    validateJsonValue(value, new Set());
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw inputError();
    return encoded;
  } catch {
    throw inputError();
  }
}

function validDateMilliseconds(value) {
  if (!isObject(value) || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype) return null;
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function validateStoredDocument(document, expectedId) {
  const shape = plainObjectDescriptors(document);
  if (!shape) throw dataError();
  const allowed = new Set(['_id', 'valueJson', 'expiresAt', 'createdAt', 'updatedAt']);
  const required = ['_id', 'valueJson', 'createdAt', 'updatedAt'];
  if (shape.keys.some(key => !allowed.has(key))
      || required.some(key => !Object.hasOwn(shape.descriptors, key))) {
    throw dataError();
  }

  const id = shape.descriptors._id.value;
  const valueJson = shape.descriptors.valueJson.value;
  const createdAt = shape.descriptors.createdAt.value;
  const updatedAt = shape.descriptors.updatedAt.value;
  const expiresDescriptor = shape.descriptors.expiresAt;
  const expiresAt = expiresDescriptor ? expiresDescriptor.value : null;
  if (id !== expectedId
      || typeof valueJson !== 'string'
      || validDateMilliseconds(createdAt) === null
      || validDateMilliseconds(updatedAt) === null
      || (expiresDescriptor && validDateMilliseconds(expiresAt) === null)) {
    throw dataError();
  }
  return { valueJson, expiresAt, updatedAt };
}

function requiredResultDescriptors(result, requiredKeys) {
  const shape = plainObjectDescriptors(result);
  if (!shape || requiredKeys.some(key => !Object.hasOwn(shape.descriptors, key))) {
    throw operationError();
  }
  return shape.descriptors;
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateUpdateResult(result, expectedId) {
  const descriptors = requiredResultDescriptors(result, [
    'acknowledged',
    'matchedCount',
    'modifiedCount',
    'upsertedCount',
    'upsertedId',
  ]);
  const acknowledged = descriptors.acknowledged.value;
  const matchedCount = descriptors.matchedCount.value;
  const modifiedCount = descriptors.modifiedCount.value;
  const upsertedCount = descriptors.upsertedCount.value;
  const upsertedId = descriptors.upsertedId.value;
  if (acknowledged !== true
      || !isNonnegativeSafeInteger(matchedCount)
      || !isNonnegativeSafeInteger(modifiedCount)
      || !isNonnegativeSafeInteger(upsertedCount)) {
    throw operationError();
  }

  const matched = matchedCount === 1
    && modifiedCount <= 1
    && upsertedCount === 0
    && upsertedId === null;
  const upserted = matchedCount === 0
    && modifiedCount === 0
    && upsertedCount === 1
    && upsertedId === expectedId;
  if (!matched && !upserted) throw operationError();
}

function validateDeleteResult(result) {
  const descriptors = requiredResultDescriptors(result, [
    'acknowledged',
    'deletedCount',
  ]);
  const acknowledged = descriptors.acknowledged.value;
  const deletedCount = descriptors.deletedCount.value;
  if (acknowledged !== true
      || !isNonnegativeSafeInteger(deletedCount)
      || deletedCount > 1) {
    throw operationError();
  }
}

function validateIndexName(result) {
  if (typeof result !== 'string' || result.trim() === '') throw operationError();
}

class ManagedMongoStorage extends BaseStorage {
  constructor(db, options = {}) {
    super(STORAGE_PREFIX);
    const collectionMethod = callableDataProperty(db, 'collection');
    if (!collectionMethod) throw configError();
    const now = validateOptions(options);
    this.db = db;
    this.collectionMethod = collectionMethod;
    this.now = now;
    this.collection = null;
    this.collectionMethods = null;
    this.queue = Promise.resolve();
    this.initializePromise = null;
    this.stopPromise = null;
    this.initialized = false;
    this.stopping = false;
  }

  _enqueue(operation) {
    if (this.stopping) {
      return Promise.reject(storageError('STORAGE_STOPPED', 'Storage is stopped'));
    }
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  _requireInitialized() {
    if (!this.initialized) {
      throw storageError('STORAGE_NOT_INITIALIZED', 'Storage is not initialized');
    }
  }

  _key(key) {
    if (typeof key !== 'string'
        || key.length === 0
        || key.length > MAX_KEY_LENGTH
        || key.trim() !== key
        || /[\u0000-\u001f\u007f]/.test(key)) {
      throw inputError();
    }
    return this.prefixKey + key;
  }

  _now() {
    let milliseconds;
    try {
      milliseconds = Reflect.apply(this.now, undefined, []);
    } catch {
      throw clockError();
    }
    if (typeof milliseconds !== 'number'
        || !Number.isFinite(milliseconds)
        || milliseconds < 0
        || milliseconds > MAX_DATE_MILLISECONDS) {
      throw clockError();
    }
    const date = new Date(milliseconds);
    if (validDateMilliseconds(date) === null) throw clockError();
    return { milliseconds, date };
  }

  _expiry(milliseconds, ttlSeconds) {
    const expiresAtSeconds = Math.floor(milliseconds / 1000) + ttlSeconds;
    const expiresAtMilliseconds = expiresAtSeconds * 1000;
    if (!Number.isSafeInteger(expiresAtSeconds)
        || !Number.isSafeInteger(expiresAtMilliseconds)
        || expiresAtMilliseconds > MAX_DATE_MILLISECONDS) {
      throw inputError();
    }
    return new Date(expiresAtMilliseconds);
  }

  _call(method, args) {
    let result;
    try {
      result = Reflect.apply(this.collectionMethods[method], this.collection, args);
    } catch {
      return Promise.reject(operationError());
    }
    if (isProxy(result) || !isPromise(result)) {
      return Promise.resolve({ value: result });
    }
    return Promise.prototype.then.call(
      result,
      value => ({ value }),
      () => { throw operationError(); },
    );
  }

  initialize() {
    if (this.initializePromise) return this.initializePromise;
    const initializing = this._enqueue(async () => {
      try {
        const collection = Reflect.apply(this.collectionMethod, this.db, [COLLECTION_NAME]);
        if (!isObject(collection) || isProxy(collection)) throw configError();
        const methods = Object.create(null);
        for (const method of COLLECTION_METHODS) {
          const callable = callableDataProperty(collection, method);
          if (!callable) throw configError();
          methods[method] = callable;
        }
        this.collection = collection;
        this.collectionMethods = methods;
        const { value: indexName } = await this._call('createIndex', [
          { expiresAt: 1 },
          {
            expireAfterSeconds: 0,
            name: 'fdk_sessions_expiresAt_ttl',
          },
        ]);
        validateIndexName(indexName);
        this.initialized = true;
      } catch {
        this.collection = null;
        this.collectionMethods = null;
        this.initialized = false;
        throw storageError(
          'STORAGE_INITIALIZATION_FAILED',
          'Storage initialization failed',
        );
      }
    });
    this.initializePromise = initializing;
    return initializing;
  }

  get(key) {
    if (key === undefined) {
      if (this.stopping) {
        return Promise.reject(storageError('STORAGE_STOPPED', 'Storage is stopped'));
      }
      if (!this.initialized) {
        return Promise.reject(storageError('STORAGE_NOT_INITIALIZED', 'Storage is not initialized'));
      }
      return Promise.resolve(null);
    }
    let fullKey;
    try {
      fullKey = this._key(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue(async () => {
      this._requireInitialized();
      const { value: document } = await this._call('findOne', [{ _id: fullKey }]);
      if (document === null) return null;
      const stored = validateStoredDocument(document, fullKey);
      if (stored.expiresAt !== null) {
        const expiresAtMilliseconds = validDateMilliseconds(stored.expiresAt);
        const { milliseconds } = this._now();
        if (expiresAtMilliseconds <= milliseconds) {
          const { value: deleteResult } = await this._call('deleteOne', [{
            _id: fullKey,
            expiresAt: stored.expiresAt,
            updatedAt: stored.updatedAt,
          }]);
          validateDeleteResult(deleteResult);
          return null;
        }
      }
      try {
        return JSON.parse(stored.valueJson);
      } catch {
        throw dataError();
      }
    });
  }

  set(key, value) {
    let fullKey;
    let valueJson;
    try {
      fullKey = this._key(key);
      valueJson = serializeValue(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue(async () => {
      this._requireInitialized();
      const { date } = this._now();
      const { value: updateResult } = await this._call('updateOne', [
        { _id: fullKey },
        {
          $set: { valueJson, updatedAt: date },
          $setOnInsert: { createdAt: date },
          $unset: { expiresAt: '' },
        },
        { upsert: true },
      ]);
      validateUpdateResult(updateResult, fullKey);
    });
  }

  setex(key, value, ttlSeconds) {
    let fullKey;
    let valueJson;
    try {
      fullKey = this._key(key);
      valueJson = serializeValue(value);
      if (!Number.isSafeInteger(ttlSeconds)
          || ttlSeconds <= 0
          || ttlSeconds > MAX_TTL_SECONDS) {
        throw inputError();
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue(async () => {
      this._requireInitialized();
      const { milliseconds, date } = this._now();
      const expiresAt = this._expiry(milliseconds, ttlSeconds);
      const { value: updateResult } = await this._call('updateOne', [
        { _id: fullKey },
        {
          $set: { valueJson, expiresAt, updatedAt: date },
          $setOnInsert: { createdAt: date },
        },
        { upsert: true },
      ]);
      validateUpdateResult(updateResult, fullKey);
    });
  }

  del(key) {
    let fullKey;
    try {
      fullKey = this._key(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue(async () => {
      this._requireInitialized();
      const { value: deleteResult } = await this._call('deleteOne', [{ _id: fullKey }]);
      validateDeleteResult(deleteResult);
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.queue.then(() => undefined);
    return this.stopPromise;
  }
}

module.exports = { ManagedMongoStorage, STORAGE_PREFIX };
