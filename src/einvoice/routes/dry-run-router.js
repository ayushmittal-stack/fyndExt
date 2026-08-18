'use strict';

const crypto = require('crypto');
const express = require('express');
const { types } = require('util');
const { EinvoiceError } = require('../errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DOWNLOAD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*-oeis-diagnostic\.json$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OEIS_API_KEY_PATTERN = /^[\x20-\x7e]{1,1024}$/;
const POD_INPUT_FIELDS = Object.freeze([
  'method', 'url', 'requestJson', 'requestHash', 'byteCount', 'apiKey',
]);

function invalidRouter() {
  const error = new Error('Dry-run router configuration is invalid');
  error.code = 'DRY_RUN_ROUTER_CONFIG_INVALID';
  return error;
}

function ownDataValue(value, field) {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function snapshotService(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidRouter();
    }
    const snapshot = {};
    for (const field of [
      'listDryRuns', 'listDryRunFailures', 'getDryRunJourney', 'getDryRunRequest',
      'getDryRunPodCurl',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function') {
        throw invalidRouter();
      }
      snapshot[field] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalidRouter();
  }
}

function snapshotPodInputEnvelope(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidRouter();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== POD_INPUT_FIELDS.length
        || keys.some(key => typeof key !== 'string' || !POD_INPUT_FIELDS.includes(key))) {
      throw invalidRouter();
    }
    const result = {};
    for (const field of POD_INPUT_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw invalidRouter();
      }
      result[field] = descriptor.value;
    }
    if (result.method !== 'POST'
        || typeof result.url !== 'string'
        || typeof result.requestJson !== 'string'
        || typeof result.requestHash !== 'string'
        || !HASH_PATTERN.test(result.requestHash)
        || !Number.isSafeInteger(result.byteCount) || result.byteCount <= 0
        || typeof result.apiKey !== 'string'
        || result.apiKey !== result.apiKey.trim()
        || !OEIS_API_KEY_PATTERN.test(result.apiKey)) {
      throw invalidRouter();
    }
    const parsed = new URL(result.url);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username !== '' || parsed.password !== ''
        || parsed.search !== '' || parsed.hash !== ''
        || parsed.href !== result.url
        || Buffer.byteLength(result.requestJson, 'utf8') !== result.byteCount
        || crypto.createHash('sha256').update(result.requestJson, 'utf8').digest('hex')
          !== result.requestHash) {
      throw invalidRouter();
    }
    return result;
  } catch {
    throw invalidRouter();
  }
}

function authenticatedCompanyId(req) {
  const session = ownDataValue(req, 'fdkSession');
  if (session === null || typeof session !== 'object' || types.isProxy(session)) return null;
  const companyId = ownDataValue(session, 'company_id');
  if (Number.isSafeInteger(companyId) && companyId > 0) return String(companyId);
  if (typeof companyId === 'string' && /^[1-9]\d*$/.test(companyId)) return companyId;
  return null;
}

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseListQuery(req) {
  const limitValue = ownDataValue(req.query, 'limit');
  const cursorValue = ownDataValue(req.query, 'before_id');
  const limit = limitValue === undefined ? DEFAULT_LIMIT : parsePositiveInteger(limitValue);
  const beforeId = cursorValue === undefined ? null : parsePositiveInteger(cursorValue);
  if (limit === null || limit > MAX_LIMIT || (cursorValue !== undefined && beforeId === null)) {
    return null;
  }
  return { limit, beforeId };
}

function isNotFound(error) {
  try {
    return error instanceof EinvoiceError && ownDataValue(error, 'code') === 'DRY_RUN_NOT_FOUND';
  } catch {
    return false;
  }
}

function notFound(res) {
  return res.status(404).json({ success: false });
}

function route(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (isNotFound(error)) return notFound(res);
      return next(error);
    }
    return undefined;
  };
}

function dryRunSecurityHeaders(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function dryRunGetOnly(req, res, next) {
  if (req.method !== 'GET') return notFound(res);
  return next();
}

function createDryRunRouter(options = {}) {
  const dryRunService = snapshotService(ownDataValue(options, 'dryRunService'));
  const router = express.Router();

  router.get('/', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const query = parseListQuery(req);
    if (companyId === null || query === null) return notFound(res);
    const result = await dryRunService.listDryRuns({ companyId, ...query });
    return res.json(result);
  }));

  router.get('/failures', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const query = parseListQuery(req);
    if (companyId === null || query === null) return notFound(res);
    const result = await dryRunService.listDryRunFailures({ companyId, ...query });
    return res.json(result);
  }));

  router.get('/:jobId/oeis-pod-curl', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const jobId = parsePositiveInteger(req.params.jobId);
    if (companyId === null || jobId === null) return notFound(res);
    const result = await dryRunService.getDryRunPodCurl({ companyId, jobId });
    return res.json(snapshotPodInputEnvelope(result));
  }));

  router.get('/:jobId/oeis-request', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const jobId = parsePositiveInteger(req.params.jobId);
    if (companyId === null || jobId === null) return notFound(res);
    const result = await dryRunService.getDryRunRequest({ companyId, jobId });
    const rawJson = ownDataValue(result, 'rawJson');
    const filename = ownDataValue(result, 'filename');
    const contentType = ownDataValue(result, 'contentType');
    const sanitized = ownDataValue(result, 'sanitized');
    if (typeof rawJson !== 'string' || typeof filename !== 'string'
        || !DOWNLOAD_FILENAME.test(filename) || contentType !== 'application/json'
        || sanitized !== true) {
      throw invalidRouter();
    }
    const bytes = Buffer.from(rawJson, 'utf8');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return res.end(bytes);
  }));

  router.get('/:jobId', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const jobId = parsePositiveInteger(req.params.jobId);
    if (companyId === null || jobId === null) return notFound(res);
    const result = await dryRunService.getDryRunJourney({ companyId, jobId });
    return res.json(result);
  }));

  return router;
}

module.exports = { createDryRunRouter, dryRunSecurityHeaders, dryRunGetOnly };
