import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import {
  getDryRunJourney,
  getDryRunRequestBlob,
  listDryRunFailures,
  listDryRuns,
} from '../../services/dryRunApi';

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
