import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { webcrypto } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';

import {
  getDryRunPodCurl,
  getDryRunJourney,
  getDryRunRequestBlob,
  listDryRunFailures,
  listDryRuns,
} from '../../services/dryRunApi';

const POD_REQUEST_JSON = '[{"NOTE":"O\'Reilly $HOME `uname` $(id); * ? [x]","UNICODE":"رياض"}]';
const POD_REQUEST_HASH = '0031c9b6b00670fdc2102695338f1db6c6e8e8ea598bef58f3c61cec35ebcaab';
const POD_URL = "https://oeis.example.test/root'quoted/$path;$(touch)/`whoami`/API/V2/Transaction/UpdateInvoiceData";
const POD_API_KEY = "live'key$HOME $(id) `uname`; * ?";
const POD_ENVELOPE = Object.freeze({
  method: 'POST',
  url: POD_URL,
  requestJson: POD_REQUEST_JSON,
  requestHash: POD_REQUEST_HASH,
  byteCount: 71,
  apiKey: POD_API_KEY,
});

const FAILURE_ITEM = Object.freeze({
  jobId: 51,
  shipmentId: 'shipment-51',
  documentNumber: 'VR-shipment-51-1',
  state: 'DATA_FAILED',
  failureCode: 'LOCAL_VALIDATION_FAILED',
  failureMessage: 'Invoice data failed local validation.',
  attemptCount: 2,
  lockRecordedAt: null,
  createdAt: '2026-08-13T09:00:00.000Z',
  failedAt: '2026-08-13T10:00:00.000Z',
  version: 3,
});

describe('dry-run API client', () => {
  let mock;
  let originalCrypto;
  let originalTextEncoder;

  beforeAll(() => {
    originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: NodeTextEncoder,
    });
  });

  afterAll(() => {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
    if (originalTextEncoder) {
      Object.defineProperty(globalThis, 'TextEncoder', originalTextEncoder);
    } else delete globalThis.TextEncoder;
  });

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => mock.restore());

  test('lists held jobs through the same-origin endpoint with company context and cursor params', async () => {
    const page = { items: [], nextBeforeId: null };
    mock.onGet('/api/einvoice/dry-runs').reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.params).toEqual({ limit: 25, before_id: 72 });
      return [200, page];
    });

    await expect(listDryRuns({ companyId: '12655', limit: 25, beforeId: 72 }))
      .resolves.toEqual(page);
  });

  test('loads a journey through the same-origin endpoint with company context', async () => {
    mock.onGet('/api/einvoice/dry-runs/42').reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      return [200, { job: { jobId: 42 } }];
    });

    await expect(getDryRunJourney({ companyId: '12655', jobId: 42 }))
      .resolves.toEqual({ job: { jobId: 42 } });
  });

  test('retrieves the stored request as an authenticated Blob without transforming bytes', async () => {
    const payload = new Blob(['[ { "TRAN_DOC_NO": "VR-42" } ]'], { type: 'application/json' });
    mock.onGet('/api/einvoice/dry-runs/42/oeis-request').reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.responseType).toBe('blob');
      return [200, payload];
    });

    await expect(getDryRunRequestBlob({ companyId: '12655', jobId: 42 }))
      .resolves.toBe(payload);
  });

  test('loads and validates a fresh pod-cURL envelope as exact response text with company context', async () => {
    mock.onGet('/api/einvoice/dry-runs/42/oeis-pod-curl').reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.responseType).toBe('text');
      expect(config.transformResponse).toHaveLength(1);
      expect(config.transformResponse[0]('{"raw":true}')).toBe('{"raw":true}');
      expect(config.validateStatus(401)).toBe(true);
      expect(config.validateStatus(500)).toBe(true);
      return [200, JSON.stringify(POD_ENVELOPE)];
    });

    await expect(getDryRunPodCurl({ companyId: '12655', jobId: 42 }))
      .resolves.toEqual(POD_ENVELOPE);
  });

  test.each([
    ['null envelope', null],
    ['array envelope', []],
    ['missing field', {
      method: 'POST', url: POD_URL, requestJson: POD_REQUEST_JSON,
      requestHash: POD_REQUEST_HASH,
    }],
    ['unknown field', { ...POD_ENVELOPE, debug: 'PRIVATE-SENTINEL' }],
    ['wrong method', { ...POD_ENVELOPE, method: 'PUT' }],
    ['credential-bearing URL', { ...POD_ENVELOPE, url: 'https://user:secret@oeis.example.test/path' }],
    ['URL query', { ...POD_ENVELOPE, url: 'https://oeis.example.test/path?token=PRIVATE-SENTINEL' }],
    ['malformed request JSON', { ...POD_ENVELOPE, requestJson: '{' }],
    ['wrong byte count', { ...POD_ENVELOPE, byteCount: 70 }],
    ['oversized byte count', { ...POD_ENVELOPE, byteCount: (10 * 1024 * 1024) + 1 }],
    ['invalid hash', { ...POD_ENVELOPE, requestHash: 'A'.repeat(64) }],
    ['hash mismatch', { ...POD_ENVELOPE, requestHash: '0'.repeat(64) }],
    ['empty API key', { ...POD_ENVELOPE, apiKey: '' }],
    ['leading API-key whitespace', { ...POD_ENVELOPE, apiKey: ' secret' }],
    ['trailing API-key whitespace', { ...POD_ENVELOPE, apiKey: 'secret ' }],
    ['API-key newline', { ...POD_ENVELOPE, apiKey: 'secret\nheader' }],
    ['non-ASCII API key', { ...POD_ENVELOPE, apiKey: 'سر' }],
    ['oversized API key', { ...POD_ENVELOPE, apiKey: 'a'.repeat(1025) }],
  ])('maps a malformed pod-cURL envelope to one fixed request-failed error: %s', async (_case, body) => {
    mock.onGet('/api/einvoice/dry-runs/42/oeis-pod-curl').reply(200, JSON.stringify(body));

    await expect(getDryRunPodCurl({ companyId: '12655', jobId: 42 })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
  });

  test.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [500, 'request-failed'],
  ])('sanitizes pod-cURL HTTP %s as %s without exposing the response', async (status, kind) => {
    mock.onGet('/api/einvoice/dry-runs/42/oeis-pod-curl').reply(
      status,
      JSON.stringify({ message: 'PRIVATE-SENTINEL endpoint, payload, and key detail' }),
    );

    await expect(getDryRunPodCurl({ companyId: '12655', jobId: 42 })).rejects.toMatchObject({
      kind,
      message: expect.not.stringContaining('PRIVATE-SENTINEL'),
    });
  });

  test('rejects invalid pod-cURL request identity before issuing a network request', async () => {
    await expect(getDryRunPodCurl({ companyId: '', jobId: 0 })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    expect(mock.history.get).toHaveLength(0);
  });

  test('lists a projected failure page through the dedicated endpoint and safe company cursor context', async () => {
    const serverItem = {
      ...FAILURE_ITEM,
      buyerName: 'BUYER-SENTINEL',
      snapshot: { private: 'SNAPSHOT-SENTINEL' },
      rawError: 'RAW-ERROR-SENTINEL',
    };
    const serverPage = { items: [serverItem], nextBeforeId: 51, privateDebug: 'PAGE-SENTINEL' };
    mock.onGet('/api/einvoice/dry-runs/failures').reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.params).toEqual({ limit: 25, before_id: 72 });
      expect(config.responseType).toBe('text');
      expect(config.transformResponse).toHaveLength(1);
      expect(config.transformResponse[0]('{"raw":true}')).toBe('{"raw":true}');
      expect(config.validateStatus(401)).toBe(true);
      expect(config.validateStatus(500)).toBe(true);
      return [200, JSON.stringify(serverPage)];
    });

    const result = await listDryRunFailures({ companyId: '12655', limit: 25, beforeId: 72 });

    expect(result).toEqual({ items: [{ ...FAILURE_ITEM }], nextBeforeId: 51 });
    expect(Object.keys(result.items[0])).toEqual([
      'jobId', 'shipmentId', 'documentNumber', 'state', 'failureCode', 'failureMessage',
      'attemptCount', 'lockRecordedAt', 'createdAt', 'failedAt', 'version',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/BUYER-SENTINEL|SNAPSHOT-SENTINEL|RAW-ERROR-SENTINEL|PAGE-SENTINEL/);
  });

  test('omits before_id when no positive failure cursor is supplied', async () => {
    mock.onGet('/api/einvoice/dry-runs/failures').reply(config => {
      expect(config.params).toEqual({ limit: 20 });
      return [200, JSON.stringify({ items: [], nextBeforeId: null })];
    });

    await expect(listDryRunFailures({ companyId: '12655' }))
      .resolves.toEqual({ items: [], nextBeforeId: null });
  });

  test.each([
    ['null envelope', null],
    ['array envelope', []],
    ['non-array items', { items: {}, nextBeforeId: null }],
    ['unsafe cursor', { items: [], nextBeforeId: 0 }],
    ['wrong state', { items: [{ ...FAILURE_ITEM, state: 'SUBMISSION_HELD' }], nextBeforeId: null }],
    ['unsafe attempt count', { items: [{ ...FAILURE_ITEM, attemptCount: -1 }], nextBeforeId: null }],
    ['unsafe version', { items: [{ ...FAILURE_ITEM, version: -1 }], nextBeforeId: null }],
    ['empty identifier', { items: [{ ...FAILURE_ITEM, shipmentId: '' }], nextBeforeId: null }],
    ['invalid failure instant', { items: [{ ...FAILURE_ITEM, failedAt: 'not-an-instant' }], nextBeforeId: null }],
  ])('maps malformed failure data to one fixed request-failed error: %s', async (_case, body) => {
    mock.onGet('/api/einvoice/dry-runs/failures').reply(200, JSON.stringify(body));

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
  });

  test('rejects an object payload without entering its Proxy traps', async () => {
    const traps = { get: jest.fn(), ownKeys: jest.fn(), getPrototypeOf: jest.fn() };
    const payload = new Proxy({ items: [{ ...FAILURE_ITEM }], nextBeforeId: null }, {
      get(target, key, receiver) {
        traps.get();
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        traps.ownKeys();
        return Reflect.ownKeys(target);
      },
      getPrototypeOf(target) {
        traps.getPrototypeOf();
        return Reflect.getPrototypeOf(target);
      },
    });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: payload });

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    axios.get.mockRestore();
  });

  test('rejects a nested accessor value returned by JSON.parse without evaluating it', async () => {
    const nestedGetter = jest.fn(() => 'NESTED-ACCESSOR-SENTINEL');
    const nested = {};
    Object.defineProperty(nested, 'private', { enumerable: true, get: nestedGetter });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: '{"valid":"text"}' });
    const parse = jest.spyOn(JSON, 'parse').mockReturnValueOnce({
      items: [{ ...FAILURE_ITEM, failureMessage: nested }],
      nextBeforeId: null,
    });

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    expect(nestedGetter).not.toHaveBeenCalled();
    parse.mockRestore();
    axios.get.mockRestore();
  });

  test.each([
    ['sparse array', new Array(1)],
    ['array hole', [, { ...FAILURE_ITEM }]],
  ])('rejects a %s returned by JSON.parse', async (_case, items) => {
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: '{"valid":"text"}' });
    const parse = jest.spyOn(JSON, 'parse').mockReturnValueOnce({ items, nextBeforeId: null });

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    parse.mockRestore();
    axios.get.mockRestore();
  });

  test('rejects an accessor array index returned by JSON.parse without evaluating it', async () => {
    const getter = jest.fn(() => ({ ...FAILURE_ITEM }));
    const items = [];
    Object.defineProperty(items, '0', { configurable: true, enumerable: true, get: getter });
    Object.defineProperty(items, 'length', { value: 1 });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: '{"valid":"text"}' });
    const parse = jest.spyOn(JSON, 'parse').mockReturnValueOnce({ items, nextBeforeId: null });

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    expect(getter).not.toHaveBeenCalled();
    parse.mockRestore();
    axios.get.mockRestore();
  });

  test('maps a rejected object generically without reading its throwing response getter', async () => {
    const responseGetter = jest.fn(() => {
      throw new Error('RESPONSE-GETTER-SENTINEL');
    });
    const rejection = {};
    Object.defineProperty(rejection, 'response', { get: responseGetter });
    mock.restore();
    jest.spyOn(axios, 'get').mockRejectedValueOnce(rejection);

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
    });
    expect(responseGetter).not.toHaveBeenCalled();
    axios.get.mockRestore();
  });

  test.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [500, 'request-failed'],
  ])('sanitizes failure-list HTTP %s as %s', async (status, kind) => {
    mock.onGet('/api/einvoice/dry-runs/failures').reply(
      status,
      JSON.stringify({ message: 'SENTINEL raw server and buyer detail' }),
    );

    await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
      kind,
      message: expect.not.stringContaining('SENTINEL'),
    });
  });

  test.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [500, 'request-failed'],
  ])('maps HTTP %s to a stable sanitized %s error', async (status, kind) => {
    mock.onGet('/api/einvoice/dry-runs').reply(status, {
      message: 'database host and customer secret must never reach the UI',
    });

    await expect(listDryRuns({ companyId: '12655', limit: 20 })).rejects.toMatchObject({
      kind,
      message: expect.not.stringContaining('database host'),
    });
  });
});
