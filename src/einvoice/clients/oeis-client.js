'use strict';

const { EinvoiceError } = require('../errors');

const OEIS_UPDATE_PATH = '/API/V2/Transaction/UpdateInvoiceData';

function fail(code, message, retryable = false) {
  throw new EinvoiceError(code, message, { retryable });
}

function malformed() {
  fail('OEIS_MALFORMED_RESPONSE', 'OEIS request or response is malformed');
}

function classifyHttpStatus(status) {
  if (status === 429) fail('OEIS_HTTP_429', 'OEIS request was rate limited', true);
  if (status >= 500 && status <= 599) fail('OEIS_HTTP_5XX', 'OEIS service request failed', true);
  fail('OEIS_HTTP_4XX', 'OEIS request was rejected');
}

function parseSingleInvoiceRequest(requestJson, maxRequestBytes) {
  if (typeof requestJson !== 'string' || !Number.isSafeInteger(maxRequestBytes)
    || maxRequestBytes <= 0) malformed();
  if (Buffer.byteLength(requestJson, 'utf8') > maxRequestBytes) {
    fail('OEIS_REQUEST_TOO_LARGE', 'OEIS request exceeds the configured size limit');
  }

  let request;
  try {
    request = JSON.parse(requestJson);
  } catch {
    malformed();
  }
  if (!Array.isArray(request) || request.length === 0) malformed();

  let documentNumber;
  for (const row of request) {
    const prototype = row !== null && typeof row === 'object' && !Array.isArray(row)
      ? Object.getPrototypeOf(row)
      : undefined;
    if (prototype !== Object.prototype) malformed();

    if (!Object.prototype.hasOwnProperty.call(row, 'TRAN_DOC_NO')) malformed();
    const rowDocumentNumber = row.TRAN_DOC_NO;
    if (typeof rowDocumentNumber !== 'string' || rowDocumentNumber.trim() === '') malformed();
    if (documentNumber === undefined) documentNumber = rowDocumentNumber;
    else if (rowDocumentNumber !== documentNumber) malformed();
  }
  return request;
}

function normalizeAxiosError(error) {
  const status = error && error.response && error.response.status;
  const code = error && error.code;
  if (Number.isInteger(status)) classifyHttpStatus(status);
  if (code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') {
    fail('OEIS_REQUEST_TOO_LARGE', 'OEIS request exceeds the configured size limit');
  }
  if (code === 'ERR_BAD_RESPONSE' && !error.response) {
    fail('OEIS_RESPONSE_TOO_LARGE', 'OEIS response exceeds the configured size limit');
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    fail('OEIS_TIMEOUT', 'OEIS request timed out', true);
  }
  if (['ERR_NETWORK', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
    || (error && (error.isAxiosError || error.request) && !error.response)) {
    fail('OEIS_NETWORK', 'OEIS network request failed', true);
  }
  malformed();
}

function createOeisClient({ axiosInstance, baseUrl, apiKey, timeoutMs, maxRequestBytes, maxResponseBytes }) {
  if (!axiosInstance || typeof axiosInstance.post !== 'function'
    || typeof baseUrl !== 'string' || baseUrl === ''
    || typeof apiKey !== 'string' || apiKey === ''
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    malformed();
  }

  axiosInstance.defaults.baseURL = baseUrl;

  return {
    async submit(requestJson) {
      const request = parseSingleInvoiceRequest(requestJson, maxRequestBytes);
      let response;
      try {
        response = await axiosInstance.post(OEIS_UPDATE_PATH, request, {
          headers: {
            Authorization: `APIkey ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
          maxRedirects: 0,
          maxBodyLength: maxRequestBytes,
          maxContentLength: maxResponseBytes,
          proxy: false,
        });
      } catch (error) {
        normalizeAxiosError(error);
      }

      if (!response || !Number.isInteger(response.status)
        || !Object.prototype.hasOwnProperty.call(response, 'data')) malformed();
      if (response.status < 200 || response.status >= 300) classifyHttpStatus(response.status);
      return {
        httpStatus: response.status,
        body: response.data,
        responseByteCount: null,
        responseSha256: null,
      };
    },
  };
}

module.exports = { createOeisClient, OEIS_UPDATE_PATH };
