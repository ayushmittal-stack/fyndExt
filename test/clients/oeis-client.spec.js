'use strict';

const axios = require('axios');
const AxiosMockAdapter = require('axios-mock-adapter');
const { EinvoiceError } = require('../../src/einvoice/errors');
const { createOeisClient, OEIS_UPDATE_PATH } = require('../../src/einvoice/clients/oeis-client');
const { SIGNED_XML, makeOeisB2cSuccess } = require('../fixtures/einvoice/oeis');

const BASE_URL = 'https://oeis.example.test';
const API_KEY = 'test-key';
const REQUEST = '[{"TRAN_DOC_NO":"VR-1-1"}]';
const MULTI_LINE_REQUEST = '[{"TRAN_DOC_NO":"VR-1-1","TRAN_LINE_NO":1},{"TRAN_DOC_NO":"VR-1-1","TRAN_LINE_NO":2}]';
const RESPONSE_CONTENT = 'customer data';

function makeErrorResponse() {
  const body = makeOeisB2cSuccess();
  body.InvoiceNumber = RESPONSE_CONTENT;
  return body;
}

function makeClient(overrides = {}) {
  const axiosInstance = axios.create();
  const mock = new AxiosMockAdapter(axiosInstance);
  const client = createOeisClient({
    axiosInstance,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    timeoutMs: 1234,
    maxRequestBytes: 2048,
    maxResponseBytes: 4096,
    ...overrides,
  });
  return { axiosInstance, mock, client };
}

test('submits every row to the fixed OEIS destination and reports parsed-body wire evidence as unavailable', async () => {
  const { axiosInstance, mock, client } = makeClient();
  mock.onPost('/API/V2/Transaction/UpdateInvoiceData').reply(config => {
    expect(config.baseURL).toBe(BASE_URL);
    expect(config.data).toBe(MULTI_LINE_REQUEST);
    expect(JSON.parse(config.data)).toEqual([
      { TRAN_DOC_NO: 'VR-1-1', TRAN_LINE_NO: 1 },
      { TRAN_DOC_NO: 'VR-1-1', TRAN_LINE_NO: 2 },
    ]);
    expect(config.headers.Authorization).toBe('APIkey test-key');
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.timeout).toBe(1234);
    expect(config.maxRedirects).toBe(0);
    expect(config.maxBodyLength).toBe(2048);
    expect(config.maxContentLength).toBe(4096);
    expect(config.proxy).toBe(false);
    return [201, makeOeisB2cSuccess()];
  });

  await expect(client.submit(MULTI_LINE_REQUEST)).resolves.toEqual({
    httpStatus: 201,
    body: makeOeisB2cSuccess(),
    responseByteCount: null,
    responseSha256: null,
  });
  expect(axiosInstance.defaults.baseURL).toBe(BASE_URL);
  expect(OEIS_UPDATE_PATH).toBe('/API/V2/Transaction/UpdateInvoiceData');
  expect(mock.history.post[0].url).toBe(OEIS_UPDATE_PATH);
});

test('adds only safe response metadata while retaining the private parsed body by reference', async () => {
  const body = {
    ...makeOeisB2cSuccess(),
    customer: { name: 'Customer Name', email: 'customer@example.test' },
    payment: { card: '4111111111111111' },
    bags: [{ id: 'private-bag' }],
    signedXml: SIGNED_XML,
    qr: 'private-qr',
  };
  const response = {
    status: 202,
    data: body,
    headers: { authorization: `APIkey ${API_KEY}` },
    config: { baseURL: BASE_URL, headers: { authorization: `APIkey ${API_KEY}` } },
    request: { raw: REQUEST },
  };
  const responseSnapshot = structuredClone(response);
  const axiosInstance = { defaults: {}, post: jest.fn().mockResolvedValue(response) };
  const client = createOeisClient({
    axiosInstance,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    timeoutMs: 1234,
    maxRequestBytes: 2048,
    maxResponseBytes: 4096,
  });

  const result = await client.submit(REQUEST);

  expect(result).toEqual({
    httpStatus: 202,
    body,
    responseByteCount: null,
    responseSha256: null,
  });
  expect(Object.keys(result)).toEqual([
    'httpStatus', 'body', 'responseByteCount', 'responseSha256',
  ]);
  expect(result.body).toBe(body);
  const { body: privateBody, ...safeMetadata } = result;
  expect(privateBody).toBe(body);
  expect(safeMetadata).toEqual({
    httpStatus: 202,
    responseByteCount: null,
    responseSha256: null,
  });
  const normalized = JSON.stringify(safeMetadata);
  for (const sentinel of [
    API_KEY, BASE_URL, 'Customer Name', 'customer@example.test',
    '4111111111111111', 'private-bag', SIGNED_XML, 'private-qr',
  ]) {
    expect(normalized).not.toContain(sentinel);
  }
  expect(response).toEqual(responseSnapshot);
  expect(Object.isFrozen(result)).toBe(false);
  expect(Object.isFrozen(response)).toBe(false);
  expect(Object.isFrozen(body)).toBe(false);
});

test.each([
  '{',
  '[]',
  '{}',
  '[null]',
  '[[]]',
  '[true]',
  '[{}]',
  '[{"TRAN_DOC_NO":""}]',
  '[{"TRAN_DOC_NO":"   "}]',
  '[{"TRAN_DOC_NO":null}]',
  '[{"TRAN_DOC_NO":false}]',
  '[{"TRAN_DOC_NO":1}]',
  '[{"TRAN_DOC_NO":1.5}]',
  '[{"TRAN_DOC_NO":{}}]',
  '[{"TRAN_DOC_NO":[]}]',
  '[{"TRAN_DOC_NO":"VR-1-1"},{}]',
  '[{"TRAN_DOC_NO":"VR-1-1"},{"TRAN_DOC_NO":"VR-1-2"}]',
])('rejects %s before it can be submitted', async requestJson => {
  const axiosInstance = { defaults: {}, post: jest.fn() };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });

  await expect(client.submit(requestJson)).rejects.toEqual(expect.objectContaining({
    name: 'EinvoiceError', code: 'OEIS_MALFORMED_RESPONSE', retryable: false,
  }));
  expect(axiosInstance.post).not.toHaveBeenCalled();
});

test('requires each row to own its document number even when Object.prototype is polluted', async () => {
  const axiosInstance = { defaults: {}, post: jest.fn() };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });
  Object.defineProperty(Object.prototype, 'TRAN_DOC_NO', {
    configurable: true,
    value: 'INHERITED-INVOICE',
  });

  try {
    await expect(client.submit('[{}]')).rejects.toEqual(expect.objectContaining({
      code: 'OEIS_MALFORMED_RESPONSE', retryable: false,
    }));
    expect(axiosInstance.post).not.toHaveBeenCalled();
  } finally {
    delete Object.prototype.TRAN_DOC_NO;
  }
});

test('does not invoke an inherited document-number getter', async () => {
  const axiosInstance = { defaults: {}, post: jest.fn() };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });
  Object.defineProperty(Object.prototype, 'TRAN_DOC_NO', {
    configurable: true,
    get() { throw new Error('unsafe inherited getter'); },
  });

  try {
    await expect(client.submit('[{}]')).rejects.toEqual(expect.objectContaining({
      code: 'OEIS_MALFORMED_RESPONSE', retryable: false,
    }));
    expect(axiosInstance.post).not.toHaveBeenCalled();
  } finally {
    delete Object.prototype.TRAN_DOC_NO;
  }
});

test('rejects a null-prototype row returned by a compromised parser', async () => {
  const row = Object.assign(Object.create(null), { TRAN_DOC_NO: 'VR-1-1' });
  const axiosInstance = { defaults: {}, post: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });
  const parse = jest.spyOn(JSON, 'parse').mockReturnValue([row]);

  try {
    await expect(client.submit(REQUEST)).rejects.toEqual(expect.objectContaining({
      code: 'OEIS_MALFORMED_RESPONSE', retryable: false,
    }));
    expect(axiosInstance.post).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test('classifies a syntactically valid oversized UTF-8 invoice as request-too-large before POST', async () => {
  const requestJson = JSON.stringify([
    { TRAN_DOC_NO: 'VR-🌟-1', TRAN_LINE_NO: 1 },
    { TRAN_DOC_NO: 'VR-🌟-1', TRAN_LINE_NO: 2 },
  ]);
  const axiosInstance = { defaults: {}, post: jest.fn() };
  const client = createOeisClient({
    axiosInstance,
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    timeoutMs: 1,
    maxRequestBytes: Buffer.byteLength(requestJson, 'utf8') - 1,
    maxResponseBytes: 2048,
  });

  await expect(client.submit(requestJson)).rejects.toEqual(expect.objectContaining({
    name: 'EinvoiceError', code: 'OEIS_REQUEST_TOO_LARGE', retryable: false,
  }));
  expect(axiosInstance.post).not.toHaveBeenCalled();
});

test.each([
  ['a timeout', mock => mock.onPost('/API/V2/Transaction/UpdateInvoiceData').timeout(), 'OEIS_TIMEOUT', true],
  ['a network error', mock => mock.onPost('/API/V2/Transaction/UpdateInvoiceData').networkError(), 'OEIS_NETWORK', true],
  ['a 400 response', mock => mock.onPost('/API/V2/Transaction/UpdateInvoiceData').reply(400, makeErrorResponse()), 'OEIS_HTTP_4XX', false],
  ['a 429 response', mock => mock.onPost('/API/V2/Transaction/UpdateInvoiceData').reply(429, makeErrorResponse()), 'OEIS_HTTP_429', true],
  ['a 503 response', mock => mock.onPost('/API/V2/Transaction/UpdateInvoiceData').reply(503, makeErrorResponse()), 'OEIS_HTTP_5XX', true],
])('normalizes %s without exposing request credentials or response data', async (_description, arrange, code, retryable) => {
  const { mock, client } = makeClient();
  arrange(mock);

  await expect(client.submit(REQUEST)).rejects.toEqual(expect.objectContaining({
    name: 'EinvoiceError', code, retryable,
  }));
  try {
    await client.submit(REQUEST);
  } catch (error) {
    expect(error).toBeInstanceOf(EinvoiceError);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(RESPONSE_CONTENT);
    expect(error.message).not.toContain('VR-1-1');
    expect(error.message).not.toContain(SIGNED_XML);
    expect(error).not.toHaveProperty('config');
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(RESPONSE_CONTENT);
    expect(JSON.stringify(error)).not.toContain('VR-1-1');
    expect(JSON.stringify(error)).not.toContain(SIGNED_XML);
  }
});

test.each([
  [400, 'OEIS_HTTP_4XX', false],
  [429, 'OEIS_HTTP_429', true],
  [503, 'OEIS_HTTP_5XX', true],
])('classifies a resolved HTTP %i response', async (status, code, retryable) => {
  const axiosInstance = {
    defaults: {},
    post: jest.fn().mockResolvedValue({ status, data: makeOeisB2cSuccess() }),
  };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });

  await expect(client.submit(REQUEST)).rejects.toEqual(expect.objectContaining({ code, retryable }));
});

test.each([
  ['a local request-size error', { code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED', message: 'test-key VR-1-1' }, 'OEIS_REQUEST_TOO_LARGE'],
  ['a response-size error without an HTTP response', { code: 'ERR_BAD_RESPONSE', message: 'test-key customer data' }, 'OEIS_RESPONSE_TOO_LARGE'],
])('keeps %s nonretryable and sanitized', async (_description, axiosError, code) => {
  const axiosInstance = {
    defaults: {},
    post: jest.fn().mockRejectedValue(axiosError),
  };
  const client = createOeisClient({
    axiosInstance, baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 1,
    maxRequestBytes: 2048, maxResponseBytes: 2048,
  });

  try {
    await client.submit(REQUEST);
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({ code, retryable: false }));
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(RESPONSE_CONTENT);
    expect(error.message).not.toContain('VR-1-1');
    expect(error).not.toHaveProperty('config');
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('cause');
    return;
  }
  throw new Error('Expected Axios failure to be normalized');
});
