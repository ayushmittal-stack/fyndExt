'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { EinvoiceError } = require('./errors');

const APPROVED_BRANCHES = Object.freeze(['DAMSGH', 'JEDSGH', 'E014', 'MD101']);
const APPROVED_PRODUCT_CODE_SET_SHA256 = '682ac1f847e41b2673ae57ac9d62847417be9369ec3d6d813d3c1c3060731adc';

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeProductCode(value) {
  return isNonEmptyString(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}

function findDuplicateJsonKey(text) {
  const length = text.length;
  const skipWhitespace = (index) => {
    while (index < length && /\s/.test(text[index])) index += 1;
    return index;
  };
  const readString = (index) => {
    const start = index;
    index += 1;
    while (index < length) {
      if (text[index] === '\\') {
        index += 2;
      } else if (text[index] === '"') {
        const end = index + 1;
        return { end, value: JSON.parse(text.slice(start, end)) };
      } else {
        index += 1;
      }
    }
    return { end: length, value: '' };
  };
  const readValue = (initialIndex, path) => {
    let index = skipWhitespace(initialIndex);
    if (text[index] === '{') {
      index = skipWhitespace(index + 1);
      const keys = new Set();
      if (text[index] === '}') return { index: index + 1 };
      while (index < length) {
        if (text[index] !== '"') return { index: length };
        const key = readString(index);
        if (keys.has(key.value)) return { duplicate: { key: key.value, path } };
        keys.add(key.value);
        index = skipWhitespace(key.end);
        if (text[index] !== ':') return { index: length };
        const value = readValue(index + 1, path.concat(key.value));
        if (value.duplicate) return value;
        index = skipWhitespace(value.index);
        if (text[index] === '}') return { index: index + 1 };
        if (text[index] !== ',') return { index: length };
        index = skipWhitespace(index + 1);
      }
      return { index: length };
    }
    if (text[index] === '[') {
      index = skipWhitespace(index + 1);
      if (text[index] === ']') return { index: index + 1 };
      while (index < length) {
        const value = readValue(index, path);
        if (value.duplicate) return value;
        index = skipWhitespace(value.index);
        if (text[index] === ']') return { index: index + 1 };
        if (text[index] !== ',') return { index: length };
        index = skipWhitespace(index + 1);
      }
      return { index: length };
    }
    if (text[index] === '"') return { index: readString(index).end };
    while (index < length && !/[\s,\]}]/.test(text[index])) index += 1;
    return { index };
  };

  return readValue(0, []).duplicate;
}

function loadMasterData({ filePath, fsImpl = fs }) {
  let contents;
  let master;
  try {
    contents = fsImpl.readFileSync(filePath, 'utf8');
  } catch {
    fail('MASTER_FILE_INVALID', 'Approved master data could not be loaded');
  }
  let duplicate;
  try {
    duplicate = findDuplicateJsonKey(contents);
    master = JSON.parse(contents);
  } catch {
    fail('MASTER_FILE_INVALID', 'Approved master data could not be loaded');
  }
  if (duplicate) {
    fail(duplicate.path.length === 1 && duplicate.path[0] === 'products'
      ? 'MASTER_DUPLICATE_PRODUCT'
      : 'MASTER_DUPLICATE_KEY', 'Approved master data contains a duplicate key');
  }

  if (!master || typeof master !== 'object' || Array.isArray(master)
      || !Array.isArray(master.branches) || !master.products
      || typeof master.products !== 'object' || Array.isArray(master.products)) {
    fail('MASTER_FILE_INVALID', 'Approved master data has an invalid structure');
  }
  if (Object.keys(master).some((key) => !['branches', 'products'].includes(key))) {
    fail('MASTER_FILE_INVALID', 'Approved master data has unapproved properties');
  }

  const branches = new Set();
  for (const branch of master.branches) {
    if (!isNonEmptyString(branch) || branch !== branch.trim()) {
      fail('MASTER_BRANCH_INVALID', 'Approved branch code is invalid');
    }
    const code = branch;
    if (branches.has(code)) fail('MASTER_DUPLICATE_BRANCH', 'Approved branch code is duplicated');
    branches.add(code);
  }
  if (branches.size !== APPROVED_BRANCHES.length
      || APPROVED_BRANCHES.some((code) => !branches.has(code))) {
    fail('MASTER_BRANCH_INVALID', 'Approved branch set is invalid');
  }

  const products = new Map();
  for (const [rawCode, product] of Object.entries(master.products)) {
    if (!isSafeProductCode(rawCode) || products.has(rawCode)
        || !product || typeof product !== 'object' || Array.isArray(product)
        || Object.keys(product).length !== 3
        || Object.keys(product).some((key) => !['uqc', 'supply_class', 'allowed_zero_rate_reason'].includes(key))
        || product.uqc !== 'OTH'
        || product.supply_class !== 'PRIVATE_HEALTHCARE_SERVICE'
        || product.allowed_zero_rate_reason !== 'VATEX-SA-HEA') {
      fail('MASTER_PRODUCT_INVALID', 'Approved product entry is invalid');
    }
    products.set(rawCode, Object.freeze({
      code: rawCode,
      uqc: product.uqc,
      supplyClass: product.supply_class,
      allowedZeroRateReason: product.allowed_zero_rate_reason,
    }));
  }
  if (products.size !== 300) {
    fail('MASTER_PRODUCT_INVALID', 'Approved registry must contain exactly 300 products');
  }
  const sortedProductCodesJson = JSON.stringify([...products.keys()].sort());
  const productCodeSetSha256 = crypto.createHash('sha256')
    .update(sortedProductCodesJson, 'utf8')
    .digest('hex');
  if (productCodeSetSha256 !== APPROVED_PRODUCT_CODE_SET_SHA256) {
    fail('MASTER_PRODUCT_INVALID', 'Approved product set is invalid');
  }

  return Object.freeze({
    getBranch(code) {
      if (!isNonEmptyString(code) || !branches.has(code)) {
        fail('MASTER_BRANCH_UNKNOWN', 'Shipment branch is not approved');
      }
      return { code };
    },
    getProduct(code) {
      if (!isNonEmptyString(code) || !products.has(code)) {
        fail('MASTER_PRODUCT_UNKNOWN', 'Shipment product is not approved');
      }
      return products.get(code);
    },
  });
}

module.exports = { loadMasterData };
