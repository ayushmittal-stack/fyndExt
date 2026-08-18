import axios from 'axios';

const BASE_URL = '/api/einvoice/dry-runs';
const MAX_POD_CURL_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_POD_CURL_RESPONSE_BYTES = 64 * 1024 * 1024;
const POD_CURL_FIELDS = Object.freeze([
  'method',
  'url',
  'requestJson',
  'requestHash',
  'byteCount',
  'apiKey',
]);
const POD_CURL_HASH_PATTERN = /^[a-f0-9]{64}$/;
const POD_CURL_API_KEY_PATTERN = /^[\x20-\x7e]{1,1024}$/;
const POD_CURL_PATH = '/API/V2/Transaction/UpdateInvoiceData';
const SANITIZED_ERRORS = new WeakSet();

const ERROR_COPY = Object.freeze({
  unauthorized: 'Your session has expired. Reauthenticate to inspect held journeys.',
  'not-found': 'The held journey is no longer available.',
  'request-failed': 'Dry-run data could not be loaded.',
});

function sanitizedError(kind) {
  const sanitized = new Error(ERROR_COPY[kind]);
  sanitized.kind = kind;
  SANITIZED_ERRORS.add(sanitized);
  return sanitized;
}

function ownResponseStatus(error) {
  try {
    if (error === null || typeof error !== 'object') return null;
    const responseDescriptor = Object.getOwnPropertyDescriptor(error, 'response');
    if (!responseDescriptor || !Object.prototype.hasOwnProperty.call(responseDescriptor, 'value')
        || responseDescriptor.value === null || typeof responseDescriptor.value !== 'object') {
      return null;
    }
    const statusDescriptor = Object.getOwnPropertyDescriptor(responseDescriptor.value, 'status');
    return statusDescriptor && Object.prototype.hasOwnProperty.call(statusDescriptor, 'value')
      ? statusDescriptor.value
      : null;
  } catch {
    return null;
  }
}

function sanitizeError(error) {
  const status = ownResponseStatus(error);
  const kind = status === 401
    ? 'unauthorized'
    : status === 404
      ? 'not-found'
      : 'request-failed';
  return sanitizedError(kind);
}

async function get(url, config, project) {
  try {
    const response = await axios.get(url, config);
    return project ? project(response.data) : response.data;
  } catch (error) {
    throw sanitizeError(error);
  }
}

function companyHeaders(companyId) {
  return { 'x-company-id': String(companyId) };
}

const FAILURE_FIELDS = Object.freeze([
  'jobId',
  'shipmentId',
  'documentNumber',
  'state',
  'failureCode',
  'failureMessage',
  'attemptCount',
  'lockRecordedAt',
  'createdAt',
  'failedAt',
  'version',
]);
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const MAX_FAILURE_RESPONSE_CHARS = 262_144;

function invalidFailureResponse() {
  throw new Error('invalid failure response');
}

function ownDataValues(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidFailureResponse();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidFailureResponse();
    }
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidFailureResponse();
    }
    result[field] = descriptor.value;
  }
  return result;
}

function safeString(value, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum
      || !SAFE_TEXT_PATTERN.test(value)) invalidFailureResponse();
  return value;
}

function safeTimestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const text = safeString(value, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) invalidFailureResponse();
  return text;
}

function projectFailureItem(value) {
  const item = ownDataValues(value, FAILURE_FIELDS);
  if (!Number.isSafeInteger(item.jobId) || item.jobId <= 0) invalidFailureResponse();
  const shipmentId = safeString(item.shipmentId, 256);
  const documentNumber = safeString(item.documentNumber, 256, { nullable: true });
  if (!['DATA_FAILED', 'INDETERMINATE'].includes(item.state)) invalidFailureResponse();
  const failureCode = safeString(item.failureCode, 64);
  if (!FAILURE_CODE_PATTERN.test(failureCode)) invalidFailureResponse();
  const failureMessage = safeString(item.failureMessage, 512);
  if (!Number.isSafeInteger(item.attemptCount) || item.attemptCount < 0
      || !Number.isSafeInteger(item.version) || item.version < 0) invalidFailureResponse();
  return {
    jobId: item.jobId,
    shipmentId,
    documentNumber,
    state: item.state,
    failureCode,
    failureMessage,
    attemptCount: item.attemptCount,
    lockRecordedAt: safeTimestamp(item.lockRecordedAt, { nullable: true }),
    createdAt: safeTimestamp(item.createdAt),
    failedAt: safeTimestamp(item.failedAt),
    version: item.version,
  };
}

function ownDataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidFailureResponse();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    invalidFailureResponse();
  }
  const result = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidFailureResponse();
    }
    result.push(descriptor.value);
  }
  return result;
}

function projectFailurePage(value) {
  const page = ownDataValues(value, ['items', 'nextBeforeId']);
  const items = ownDataArray(page.items);
  if (page.nextBeforeId !== null
      && (!Number.isSafeInteger(page.nextBeforeId) || page.nextBeforeId <= 0)) {
    invalidFailureResponse();
  }
  return {
    items: items.map(projectFailureItem),
    nextBeforeId: page.nextBeforeId,
  };
}

function projectFailureText(value) {
  if (typeof value !== 'string' || value.length === 0
      || value.length > MAX_FAILURE_RESPONSE_CHARS) invalidFailureResponse();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidFailureResponse();
  }
  return projectFailurePage(parsed);
}

function preserveRawText(value) {
  return value;
}

function resolveHttpStatus() {
  return true;
}

function invalidPodCurlResponse() {
  throw new Error('invalid pod cURL response');
}

function exactDataValues(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidPodCurlResponse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string')) {
    invalidPodCurlResponse();
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) invalidPodCurlResponse();
    result[field] = descriptor.value;
  }
  return result;
}

function safePodCurlUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    invalidPodCurlResponse();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidPodCurlResponse();
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== POD_CURL_PATH && !parsed.pathname.endsWith(POD_CURL_PATH)) {
    invalidPodCurlResponse();
  }
  return value;
}

function utf8(value) {
  if (typeof TextEncoder !== 'function') invalidPodCurlResponse();
  return new TextEncoder().encode(value);
}

async function sha256(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') invalidPodCurlResponse();
  const digest = await subtle.digest('SHA-256', value);
  const bytes = new Uint8Array(digest);
  if (bytes.length !== 32) invalidPodCurlResponse();
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function projectPodCurlEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0
      || utf8(text).byteLength > MAX_POD_CURL_RESPONSE_BYTES) invalidPodCurlResponse();
  const parsed = JSON.parse(text);
  const envelope = exactDataValues(parsed, POD_CURL_FIELDS);
  if (envelope.method !== 'POST') invalidPodCurlResponse();
  const url = safePodCurlUrl(envelope.url);
  if (typeof envelope.requestJson !== 'string' || envelope.requestJson.length === 0
      || !Number.isSafeInteger(envelope.byteCount) || envelope.byteCount <= 0
      || envelope.byteCount > MAX_POD_CURL_REQUEST_BYTES
      || typeof envelope.requestHash !== 'string'
      || !POD_CURL_HASH_PATTERN.test(envelope.requestHash)
      || typeof envelope.apiKey !== 'string'
      || envelope.apiKey !== envelope.apiKey.trim()
      || !POD_CURL_API_KEY_PATTERN.test(envelope.apiKey)) invalidPodCurlResponse();
  const requestBytes = utf8(envelope.requestJson);
  if (requestBytes.byteLength !== envelope.byteCount) invalidPodCurlResponse();
  const request = JSON.parse(envelope.requestJson);
  if (!Array.isArray(request) || request.length === 0) invalidPodCurlResponse();
  if (await sha256(requestBytes) !== envelope.requestHash) invalidPodCurlResponse();
  return {
    method: 'POST',
    url,
    requestJson: envelope.requestJson,
    requestHash: envelope.requestHash,
    byteCount: envelope.byteCount,
    apiKey: envelope.apiKey,
  };
}

function ownResponseValue(response, field) {
  if (response === null || typeof response !== 'object') invalidPodCurlResponse();
  const descriptor = Object.getOwnPropertyDescriptor(response, field);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    invalidPodCurlResponse();
  }
  return descriptor.value;
}

export function listDryRuns({ companyId, limit = 20, beforeId }) {
  const params = { limit };
  if (beforeId !== null && beforeId !== undefined) params.before_id = beforeId;
  return get(BASE_URL, {
    headers: companyHeaders(companyId),
    params,
  });
}

export function listDryRunFailures({ companyId, limit = 20, beforeId }) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100
      || (beforeId !== null && beforeId !== undefined
        && (!Number.isSafeInteger(beforeId) || beforeId <= 0))) {
    return Promise.reject(sanitizedError('request-failed'));
  }
  const params = { limit };
  if (beforeId !== null && beforeId !== undefined) params.before_id = beforeId;
  return (async () => {
    let response;
    try {
      response = await axios.get(`${BASE_URL}/failures`, {
        headers: companyHeaders(companyId),
        params,
        responseType: 'text',
        transformResponse: [preserveRawText],
        validateStatus: resolveHttpStatus,
      });
    } catch {
      throw sanitizedError('request-failed');
    }
    if (response.status === 401) throw sanitizedError('unauthorized');
    if (response.status === 404) throw sanitizedError('not-found');
    if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw sanitizedError('request-failed');
    }
    try {
      return projectFailureText(response.data);
    } catch {
      throw sanitizedError('request-failed');
    }
  })();
}

export function getDryRunJourney({ companyId, jobId }) {
  return get(`${BASE_URL}/${jobId}`, {
    headers: companyHeaders(companyId),
  });
}

export function getDryRunRequestBlob({ companyId, jobId }) {
  return get(`${BASE_URL}/${jobId}/oeis-request`, {
    headers: companyHeaders(companyId),
    responseType: 'blob',
  });
}

export async function getDryRunPodCurl({ companyId, jobId }) {
  try {
    const normalizedCompanyId = String(companyId);
    if (!/^[1-9][0-9]{0,31}$/.test(normalizedCompanyId)
        || !Number.isSafeInteger(jobId) || jobId <= 0) invalidPodCurlResponse();
    let response;
    try {
      response = await axios.get(`${BASE_URL}/${jobId}/oeis-pod-curl`, {
        headers: companyHeaders(normalizedCompanyId),
        responseType: 'text',
        transformResponse: [preserveRawText],
        validateStatus: resolveHttpStatus,
        maxContentLength: MAX_POD_CURL_RESPONSE_BYTES,
      });
    } catch {
      throw sanitizedError('request-failed');
    }
    const status = ownResponseValue(response, 'status');
    if (status === 401) throw sanitizedError('unauthorized');
    if (status === 404) throw sanitizedError('not-found');
    if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
      throw sanitizedError('request-failed');
    }
    return await projectPodCurlEnvelope(ownResponseValue(response, 'data'));
  } catch (error) {
    if ((typeof error === 'object' || typeof error === 'function')
        && error !== null && SANITIZED_ERRORS.has(error)) throw error;
    throw sanitizedError('request-failed');
  }
}
