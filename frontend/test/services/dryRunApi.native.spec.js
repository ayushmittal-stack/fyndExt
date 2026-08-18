/** @jest-environment node */

import axios from 'axios';

import { listDryRunFailures } from '../../services/dryRunApi';

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

afterEach(() => jest.restoreAllMocks());

test('native boundary rejects a nested accessor without evaluating its sentinel', async () => {
  const nestedGetter = jest.fn(() => 'NATIVE-NESTED-ACCESSOR-SENTINEL');
  const nested = {};
  Object.defineProperty(nested, 'private', { enumerable: true, get: nestedGetter });
  const payload = {
    items: [{ ...FAILURE_ITEM, failureMessage: nested }],
    nextBeforeId: null,
  };
  jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: payload });

  await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
    kind: 'request-failed',
    message: 'Dry-run data could not be loaded.',
  });
  expect(nestedGetter).not.toHaveBeenCalled();
});

test('native boundary rejects a top-level payload Proxy without entering traps', async () => {
  const traps = { get: jest.fn(), ownKeys: jest.fn(), getPrototypeOf: jest.fn() };
  const payload = new Proxy({ items: [], nextBeforeId: null }, {
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
  jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: payload });

  await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
    kind: 'request-failed',
    message: 'Dry-run data could not be loaded.',
  });
  expect(traps.get).not.toHaveBeenCalled();
  expect(traps.ownKeys).not.toHaveBeenCalled();
  expect(traps.getPrototypeOf).not.toHaveBeenCalled();
});

test('native boundary maps rejection without reading a throwing response getter', async () => {
  const responseGetter = jest.fn(() => {
    throw new Error('NATIVE-RESPONSE-GETTER-SENTINEL');
  });
  const rejection = {};
  Object.defineProperty(rejection, 'response', { get: responseGetter });
  jest.spyOn(axios, 'get').mockRejectedValueOnce(rejection);

  await expect(listDryRunFailures({ companyId: '12655' })).rejects.toMatchObject({
    kind: 'request-failed',
    message: 'Dry-run data could not be loaded.',
  });
  expect(responseGetter).not.toHaveBeenCalled();
});
