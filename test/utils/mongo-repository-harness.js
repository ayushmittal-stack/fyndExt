'use strict';

const {
  Long,
  MongoServerError,
  ObjectId,
} = require('mongodb');

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function cloneBson(value) {
  if (!isObject(value)) return value;
  if (Long.isLong(value)) return Long.fromBits(value.low, value.high, value.unsigned);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(cloneBson);
  const clone = {};
  for (const key of Reflect.ownKeys(value)) clone[key] = cloneBson(value[key]);
  return clone;
}

function comparable(value) {
  if (Long.isLong(value)) return value.toBigInt();
  if (value instanceof Date) return BigInt(value.getTime());
  if (value instanceof ObjectId) return value.toHexString();
  return value;
}

function compareBson(left, right) {
  const actualLeft = comparable(left);
  const actualRight = comparable(right);
  if (actualLeft === actualRight) return 0;
  return actualLeft < actualRight ? -1 : 1;
}

function sameBson(left, right) {
  if (left === right) return true;
  if (Long.isLong(left) || Long.isLong(right)) {
    return Long.isLong(left) && Long.isLong(right) && left.equals(right);
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return left instanceof ObjectId && right instanceof ObjectId && left.equals(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameBson(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameBson(left[key], right[key]));
}

function getPath(document, path) {
  return String(path).split('.').reduce(
    (value, key) => (isObject(value) ? value[key] : undefined),
    document,
  );
}

function isOperatorObject(value) {
  return isObject(value) && !Array.isArray(value) && !Long.isLong(value)
    && !(value instanceof Date) && !(value instanceof ObjectId)
    && Object.keys(value).some(key => key.startsWith('$'));
}

function matchesCondition(actual, expected) {
  if (!isOperatorObject(expected)) return sameBson(actual, expected);
  return Object.entries(expected).every(([operator, operand]) => {
    if (operator === '$lt') return actual !== undefined && compareBson(actual, operand) < 0;
    if (operator === '$lte') return actual !== undefined && compareBson(actual, operand) <= 0;
    if (operator === '$gt') return actual !== undefined && compareBson(actual, operand) > 0;
    if (operator === '$gte') return actual !== undefined && compareBson(actual, operand) >= 0;
    if (operator === '$ne') return !sameBson(actual, operand);
    if (operator === '$in') return Array.isArray(operand)
      && operand.some(value => sameBson(actual, value));
    if (operator === '$nin') return Array.isArray(operand)
      && operand.every(value => !sameBson(actual, value));
    if (operator === '$exists') return operand === (actual !== undefined);
    if (operator === '$type') {
      if (operand === 'long') return Long.isLong(actual);
      if (operand === 'date') return actual instanceof Date;
      return false;
    }
    throw new Error(`Unsupported harness filter operator: ${operator}`);
  });
}

function matchesFilter(document, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return Array.isArray(expected)
      && expected.some(candidate => matchesFilter(document, candidate));
    if (field === '$and') return Array.isArray(expected)
      && expected.every(candidate => matchesFilter(document, candidate));
    return matchesCondition(getPath(document, field), expected);
  });
}

function projectDocument(document, projection) {
  if (!projection) return cloneBson(document);
  const inclusions = Object.entries(projection).filter(([, value]) => value === 1);
  if (inclusions.length > 0) {
    const projected = {};
    for (const [key] of inclusions) {
      if (document[key] !== undefined) projected[key] = cloneBson(document[key]);
    }
    if (projection._id !== 0 && document._id !== undefined && projected._id === undefined) {
      projected._id = cloneBson(document._id);
    }
    return projected;
  }
  const projected = cloneBson(document);
  for (const [key, value] of Object.entries(projection)) {
    if (value === 0) delete projected[key];
  }
  return projected;
}

function compareBySort(left, right, sort) {
  for (const [field, direction] of Object.entries(sort || {})) {
    const compared = compareBson(getPath(left, field), getPath(right, field));
    if (compared !== 0) return direction < 0 ? -compared : compared;
  }
  return 0;
}

function duplicateKeyError() {
  const error = new MongoServerError({ message: 'synthetic duplicate key', code: 11000 });
  error.code = 11000;
  return error;
}

function indexConflictError(code = 85) {
  const error = new MongoServerError({ message: 'synthetic index conflict', code });
  error.code = code;
  return error;
}

function transientTransactionError() {
  const error = new MongoServerError({ message: 'synthetic transaction contention' });
  error.addErrorLabel('TransientTransactionError');
  return error;
}

function unknownCommitError() {
  const error = new MongoServerError({ message: 'synthetic unknown commit' });
  error.addErrorLabel('UnknownTransactionCommitResult');
  return error;
}

function cloneCollectionState(collection) {
  return {
    documents: collection.documents.map(cloneBson),
    indexes: collection.indexes.map(cloneBson),
    options: cloneBson(collection.options),
  };
}

function cloneDatabaseState(collections) {
  const clone = new Map();
  for (const [name, collection] of collections) clone.set(name, cloneCollectionState(collection));
  return clone;
}

function indexSignature(index) {
  return {
    key: index.key,
    unique: index.unique === true,
    expireAfterSeconds: index.expireAfterSeconds,
    collation: index.collation,
    sparse: index.sparse === true,
    partialFilterExpression: index.partialFilterExpression,
    hidden: index.hidden === true,
  };
}

function uniqueKey(document, index) {
  return Object.keys(index.key).map(field => getPath(document, field));
}

function validateUniqueIndexes(collection) {
  for (const index of collection.indexes.filter(candidate => candidate.unique === true)) {
    for (let left = 0; left < collection.documents.length; left += 1) {
      for (let right = left + 1; right < collection.documents.length; right += 1) {
        const leftKey = uniqueKey(collection.documents[left], index);
        const rightKey = uniqueKey(collection.documents[right], index);
        if (sameBson(leftKey, rightKey)) throw duplicateKeyError();
      }
    }
  }
}

function applyUpdate(document, update, inserted) {
  const next = cloneBson(document);
  const operators = Object.keys(update);
  if (operators.some(operator => !['$setOnInsert', '$set', '$unset', '$inc', '$min'].includes(operator))) {
    throw new Error('Unsupported harness update');
  }
  if (inserted && update.$setOnInsert) Object.assign(next, cloneBson(update.$setOnInsert));
  if (update.$set) Object.assign(next, cloneBson(update.$set));
  for (const key of Object.keys(update.$unset || {})) delete next[key];
  for (const [key, increment] of Object.entries(update.$inc || {})) {
    if (Long.isLong(next[key]) && Long.isLong(increment)) next[key] = next[key].add(increment);
    else next[key] += increment;
  }
  for (const [key, minimum] of Object.entries(update.$min || {})) {
    if (next[key] === undefined || compareBson(minimum, next[key]) < 0) next[key] = cloneBson(minimum);
  }
  return next;
}

class FakeCursor {
  constructor(documents, projection) {
    this.documents = documents.map(document => projectDocument(document, projection));
    this.maximum = null;
  }

  sort(specification) {
    this.documents.sort((left, right) => compareBySort(left, right, specification));
    return this;
  }

  limit(value) {
    this.maximum = value;
    return this;
  }

  async toArray() {
    const documents = this.maximum === null
      ? this.documents
      : this.documents.slice(0, this.maximum);
    return documents.map(cloneBson);
  }
}

class FakeCollection {
  constructor(harness, name) {
    this.harness = harness;
    this.collectionName = name;
  }

  _state(options, write = false) {
    const session = options && options.session;
    if (session !== undefined) {
      if (!(session instanceof FakeSession) || session.harness !== this.harness || !session.active) {
        throw new Error('Harness operation used an inactive or foreign session');
      }
      return session.transactionState.get(this.collectionName);
    }
    if (write && this.harness.enforceTransactionalWrites) {
      throw new Error('Harness write requires an active session');
    }
    if (write) this.harness.namespaces.add(this.collectionName);
    return this.harness.collections.get(this.collectionName);
  }

  _record(method, details = {}) {
    this.harness.trace.operations.push({
      collection: this.collectionName,
      method,
      ...cloneBson(details),
    });
  }

  _intercept(method) {
    const queue = this.harness.intercepts.get(`${this.collectionName}.${method}`);
    if (!queue || queue.length === 0) return { intercepted: false };
    const intercept = queue[0];
    if (intercept.remainingCalls > 1) {
      intercept.remainingCalls -= 1;
      return { intercepted: false };
    }
    queue.shift();
    if (intercept.kind === 'throw') throw intercept.value;
    return { intercepted: true, kind: intercept.kind, value: intercept.value };
  }

  async createIndex(key, options = {}) {
    this._record('createIndex', { key, options });
    const intercepted = this._intercept('createIndex');
    if (intercepted.kind === 'return') return intercepted.value;
    if (intercepted.kind === 'gate') await intercepted.value;
    this.harness.namespaces.add(this.collectionName);
    const state = this._state(undefined, false);
    const definition = { v: 2, key: cloneBson(key), name: options.name };
    for (const field of ['unique', 'expireAfterSeconds', 'collation', 'sparse',
      'partialFilterExpression', 'hidden']) {
      if (options[field] !== undefined) definition[field] = cloneBson(options[field]);
    }
    if (this.harness.omitSimpleCollationMetadata
        && definition.collation?.locale === 'simple'
        && Reflect.ownKeys(definition.collation).length === 1) {
      delete definition.collation;
    }
    const named = state.indexes.find(index => index.name === definition.name);
    if (named) {
      if (!sameBson(indexSignature(named), indexSignature(definition))) throw indexConflictError(85);
      return definition.name;
    }
    const equivalent = state.indexes.find(index => (
      sameBson(indexSignature(index), indexSignature(definition))
    ));
    if (equivalent) throw indexConflictError(86);
    state.indexes.push(definition);
    return definition.name;
  }

  listIndexes() {
    this._record('listIndexes');
    const intercepted = this._intercept('listIndexes');
    if (intercepted.intercepted) return intercepted.value;
    if (!this.harness.namespaces.has(this.collectionName)) {
      const error = new MongoServerError({ message: 'synthetic namespace not found', code: 26 });
      error.code = 26;
      throw error;
    }
    return new FakeCursor(this._state(undefined, false).indexes);
  }

  async insertOne(document, options = {}) {
    this._record('insertOne', { document, session: options.session !== undefined });
    const intercepted = this._intercept('insertOne');
    if (intercepted.intercepted) return intercepted.value;
    const state = this._state(options, true);
    const inserted = cloneBson(document);
    if (inserted._id === undefined) inserted._id = this.harness.nextObjectId();
    state.documents.push(inserted);
    validateUniqueIndexes(state);
    return { acknowledged: true, insertedId: cloneBson(inserted._id) };
  }

  async insertMany(documents, options = {}) {
    this._record('insertMany', { documents, session: options.session !== undefined });
    const intercepted = this._intercept('insertMany');
    if (intercepted.intercepted) return intercepted.value;
    const state = this._state(options, true);
    const insertedIds = {};
    documents.forEach((document, index) => {
      const inserted = cloneBson(document);
      if (inserted._id === undefined) inserted._id = this.harness.nextObjectId();
      insertedIds[index] = cloneBson(inserted._id);
      state.documents.push(inserted);
    });
    validateUniqueIndexes(state);
    return { acknowledged: true, insertedCount: documents.length, insertedIds };
  }

  async findOne(filter, options = {}) {
    this._record('findOne', { filter, session: options.session !== undefined });
    const intercepted = this._intercept('findOne');
    if (intercepted.kind === 'return') return cloneBson(intercepted.value);
    if (intercepted.kind === 'gate') await intercepted.value;
    const state = this._state(options, false);
    let documents = state.documents.filter(document => matchesFilter(document, filter));
    if (options.sort) documents = documents.slice().sort(
      (left, right) => compareBySort(left, right, options.sort),
    );
    return documents.length === 0 ? null : projectDocument(documents[0], options.projection);
  }

  find(filter, options = {}) {
    this._record('find', { filter, session: options.session !== undefined });
    const intercepted = this._intercept('find');
    if (intercepted.intercepted) return intercepted.value;
    const state = this._state(options, false);
    return new FakeCursor(
      state.documents.filter(document => matchesFilter(document, filter)),
      options.projection,
    );
  }

  async updateOne(filter, update, options = {}) {
    this._record('updateOne', {
      filter, update, options: { upsert: options.upsert, session: options.session !== undefined },
    });
    const intercepted = this._intercept('updateOne');
    if (intercepted.intercepted) return intercepted.value;
    const state = this._state(options, true);
    const index = state.documents.findIndex(document => matchesFilter(document, filter));
    if (index >= 0) {
      state.documents[index] = applyUpdate(state.documents[index], update, false);
      validateUniqueIndexes(state);
      return {
        acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null,
      };
    }
    if (!options.upsert) {
      return {
        acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null,
      };
    }
    const base = {};
    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('$') && !isOperatorObject(value)) base[key] = cloneBson(value);
    }
    const inserted = applyUpdate(base, update, true);
    if (inserted._id === undefined) inserted._id = this.harness.nextObjectId();
    state.documents.push(inserted);
    validateUniqueIndexes(state);
    return {
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 1,
      upsertedId: cloneBson(inserted._id),
    };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    this._record('findOneAndUpdate', {
      filter, update, options: { ...options, session: options.session !== undefined },
    });
    const intercepted = this._intercept('findOneAndUpdate');
    if (intercepted.intercepted) return cloneBson(intercepted.value);
    const state = this._state(options, true);
    let candidates = state.documents
      .map((document, index) => ({ document, index }))
      .filter(candidate => matchesFilter(candidate.document, filter));
    if (options.sort) candidates = candidates.sort(
      (left, right) => compareBySort(left.document, right.document, options.sort),
    );
    if (candidates.length === 0) return null;
    const candidate = candidates[0];
    const before = cloneBson(candidate.document);
    state.documents[candidate.index] = applyUpdate(candidate.document, update, false);
    validateUniqueIndexes(state);
    return cloneBson(options.returnDocument === 'before'
      ? before
      : state.documents[candidate.index]);
  }

  async replaceOne(filter, replacement, options = {}) {
    this._record('replaceOne', { filter, replacement, session: options.session !== undefined });
    const state = this._state(options, true);
    const index = state.documents.findIndex(document => matchesFilter(document, filter));
    if (index < 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    state.documents[index] = cloneBson(replacement);
    validateUniqueIndexes(state);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter, options = {}) {
    this._record('deleteOne', { filter, session: options.session !== undefined });
    const state = this._state(options, true);
    const index = state.documents.findIndex(document => matchesFilter(document, filter));
    if (index < 0) return { acknowledged: true, deletedCount: 0 };
    state.documents.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async countDocuments(filter = {}, options = {}) {
    this._record('countDocuments', { filter, session: options.session !== undefined });
    return this._state(options, false).documents.filter(
      document => matchesFilter(document, filter),
    ).length;
  }
}

class FakeDatabase {
  constructor(harness) {
    this.harness = harness;
  }

  collection(name) {
    this.harness.ensureCollectionState(name);
    if (!this.harness.collectionObjects.has(name)) {
      this.harness.collectionObjects.set(name, new FakeCollection(this.harness, name));
    }
    this.harness.trace.collectionCalls.push(name);
    return this.harness.collectionObjects.get(name);
  }

  async createCollection(name, options = {}) {
    this.harness.trace.databaseOperations.push({
      method: 'createCollection', name, options: cloneBson(options),
    });
    if (this.harness.namespaces.has(name)) {
      this.harness.trace.namespaceExistsErrors += 1;
      const error = new MongoServerError({ message: 'synthetic namespace exists', code: 48 });
      error.code = 48;
      throw error;
    }
    const state = this.harness.ensureCollectionState(name);
    state.options = cloneBson(options);
    this.harness.namespaces.add(name);
    if (!this.harness.collectionObjects.has(name)) {
      this.harness.collectionObjects.set(name, new FakeCollection(this.harness, name));
    }
    return this.harness.collectionObjects.get(name);
  }

  listCollections(filter = {}, options = {}) {
    this.harness.trace.databaseOperations.push({
      method: 'listCollections', filter: cloneBson(filter), options: cloneBson(options),
    });
    if (this.harness.rejectListCollectionsInFilter
        && filter?.name?.$in !== undefined) {
      const error = new MongoServerError({
        message: "can't get regex from filter doc not a regex",
        code: 8000,
      });
      error.code = 8000;
      throw error;
    }
    const documents = [...this.harness.namespaces]
      .filter(name => matchesFilter({ name }, filter))
      .map(name => ({
        name,
        type: 'collection',
        options: cloneBson(this.harness.ensureCollectionState(name).options),
        info: { readOnly: false },
        idIndex: { v: 2, key: { _id: 1 }, name: '_id_' },
      }));
    return new FakeCursor(documents);
  }
}

class FakeSession {
  constructor(harness) {
    this.harness = harness;
    this.active = false;
    this.ended = false;
    this.aborted = false;
    this.transactionState = null;
    this.baseRevision = null;
  }

  startTransaction(options) {
    if (this.active) throw new Error('Harness transaction is already active');
    this.harness.trace.transactionOptions.push(cloneBson(options));
    this.baseRevision = this.harness.revision;
    this.transactionState = cloneDatabaseState(this.harness.collections);
    this.active = true;
    this.aborted = false;
    this.harness.trace.transactionCallbacks += 1;
  }

  async commitTransaction() {
    if (!this.active) throw new Error('Harness transaction is not active');
    if (this.harness.beforeCommitGate) {
      const gate = this.harness.beforeCommitGate;
      this.harness.beforeCommitGate = null;
      gate.startedResolve();
      await gate.releasePromise;
    }
    if (this.baseRevision !== this.harness.revision) {
      this.active = false;
      throw transientTransactionError();
    }
    for (const collection of this.transactionState.values()) validateUniqueIndexes(collection);
    this.harness.collections = this.transactionState;
    this.harness.revision += 1;
    this.harness.trace.commits += 1;
    this.active = false;
    if (this.harness.unknownCommitAfterWrite) {
      this.harness.unknownCommitAfterWrite = false;
      throw unknownCommitError();
    }
  }

  async withTransaction(callback, options) {
    this.harness.trace.transactionOptions.push(cloneBson(options));
    const maximumAttempts = this.harness.maximumTransactionAttempts;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const baseRevision = this.harness.revision;
      this.transactionState = cloneDatabaseState(this.harness.collections);
      this.active = true;
      this.aborted = false;
      this.harness.trace.transactionCallbacks += 1;
      let result;
      try {
        result = await callback();
      } catch (error) {
        this.active = false;
        if (error instanceof MongoServerError
            && error.hasErrorLabel('TransientTransactionError')
            && attempt < maximumAttempts) continue;
        throw error;
      }
      this.active = false;
      if (this.aborted) return result;
      if (this.harness.forcedCallbackReplays > 0) {
        this.harness.forcedCallbackReplays -= 1;
        continue;
      }
      if (this.harness.beforeCommitGate) {
        const gate = this.harness.beforeCommitGate;
        this.harness.beforeCommitGate = null;
        gate.startedResolve();
        await gate.releasePromise;
      }
      if (baseRevision !== this.harness.revision) {
        if (attempt < maximumAttempts) continue;
        throw transientTransactionError();
      }
      for (const collection of this.transactionState.values()) validateUniqueIndexes(collection);
      this.harness.collections = this.transactionState;
      this.harness.revision += 1;
      this.harness.trace.commits += 1;
      if (this.harness.unknownCommitAfterWrite) {
        this.harness.unknownCommitAfterWrite = false;
        throw unknownCommitError();
      }
      return result;
    }
    throw transientTransactionError();
  }

  async abortTransaction() {
    if (!this.active) throw new Error('Harness transaction is not active');
    this.aborted = true;
    this.harness.trace.aborts += 1;
  }

  async endSession() {
    this.active = false;
    this.ended = true;
    this.harness.trace.endedSessions += 1;
  }
}

class FakeClient {
  constructor(harness) {
    this.harness = harness;
  }

  startSession() {
    const session = new FakeSession(this.harness);
    this.harness.trace.startedSessions += 1;
    this.harness.sessions.push(session);
    return session;
  }

  async close() {
    this.harness.trace.clientCloseCalls += 1;
  }
}

function baseIndexes() {
  return [{ v: 2, key: { _id: 1 }, name: '_id_', unique: true }];
}

function createMongoRepositoryHarness({
  includeFdkIndex = true,
  omitSimpleCollationMetadata = false,
  rejectListCollectionsInFilter = false,
} = {}) {
  const harness = {
    collections: new Map(),
    collectionObjects: new Map(),
    namespaces: new Set(),
    intercepts: new Map(),
    sessions: [],
    revision: 0,
    objectIdSequence: 1,
    forcedCallbackReplays: 0,
    unknownCommitAfterWrite: false,
    beforeCommitGate: null,
    maximumTransactionAttempts: 8,
    enforceTransactionalWrites: false,
    omitSimpleCollationMetadata,
    rejectListCollectionsInFilter,
    trace: {
      collectionCalls: [],
      databaseOperations: [],
      namespaceExistsErrors: 0,
      operations: [],
      transactionOptions: [],
      transactionCallbacks: 0,
      startedSessions: 0,
      endedSessions: 0,
      commits: 0,
      aborts: 0,
      clientCloseCalls: 0,
    },
    ensureCollectionState(name) {
      if (!this.collections.has(name)) {
        this.collections.set(name, { documents: [], indexes: baseIndexes(), options: {} });
      }
      return this.collections.get(name);
    },
    ensureCollection(name) {
      this.namespaces.add(name);
      return this.ensureCollectionState(name);
    },
    nextObjectId() {
      const hex = this.objectIdSequence.toString(16).padStart(24, '0');
      this.objectIdSequence += 1;
      return new ObjectId(hex);
    },
    seed(name, documents) {
      const collection = this.ensureCollection(name);
      collection.documents.push(...documents.map(cloneBson));
      validateUniqueIndexes(collection);
      this.revision += 1;
    },
    replaceDocuments(name, documents) {
      const collection = this.ensureCollection(name);
      collection.documents = documents.map(cloneBson);
      validateUniqueIndexes(collection);
      this.revision += 1;
    },
    documents(name) {
      return this.ensureCollection(name).documents.map(cloneBson);
    },
    indexes(name) {
      return this.ensureCollection(name).indexes.map(cloneBson);
    },
    replaceIndexes(name, indexes) {
      this.ensureCollection(name).indexes = indexes.map(cloneBson);
    },
    replaceCollectionOptions(name, options) {
      this.ensureCollection(name).options = cloneBson(options);
    },
    throwNext(name, method, error) {
      const key = `${name}.${method}`;
      if (!this.intercepts.has(key)) this.intercepts.set(key, []);
      this.intercepts.get(key).push({ kind: 'throw', value: error });
    },
    returnNext(name, method, value) {
      const key = `${name}.${method}`;
      if (!this.intercepts.has(key)) this.intercepts.set(key, []);
      this.intercepts.get(key).push({ kind: 'return', value });
    },
    returnOnCall(name, method, callNumber, value) {
      if (!Number.isSafeInteger(callNumber) || callNumber < 1) {
        throw new Error('Harness intercept call number must be a positive safe integer');
      }
      const key = `${name}.${method}`;
      if (!this.intercepts.has(key)) this.intercepts.set(key, []);
      this.intercepts.get(key).push({
        kind: 'return', value, remainingCalls: callNumber,
      });
    },
    gateNext(name, method, promise) {
      const key = `${name}.${method}`;
      if (!this.intercepts.has(key)) this.intercepts.set(key, []);
      this.intercepts.get(key).push({ kind: 'gate', value: promise });
    },
    replayNextTransaction(times = 1) {
      this.forcedCallbackReplays = times;
    },
    makeNextCommitUnknown() {
      this.unknownCommitAfterWrite = true;
    },
    gateNextCommit() {
      let startedResolve;
      let releaseResolve;
      const started = new Promise(resolve => { startedResolve = resolve; });
      const releasePromise = new Promise(resolve => { releaseResolve = resolve; });
      this.beforeCommitGate = { startedResolve, releasePromise };
      return { started, release: releaseResolve };
    },
  };

  harness.ensureCollection('fdk_sessions');
  if (includeFdkIndex) {
    harness.ensureCollection('fdk_sessions').indexes.push({
      v: 2,
      key: { expiresAt: 1 },
      name: 'fdk_sessions_expiresAt_ttl',
      expireAfterSeconds: 0,
    });
  }
  harness.db = new FakeDatabase(harness);
  harness.client = new FakeClient(harness);
  return harness;
}

module.exports = {
  cloneBson,
  compareBson,
  createMongoRepositoryHarness,
  sameBson,
};
