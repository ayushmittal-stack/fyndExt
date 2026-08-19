'use strict';

const { createTaxPolicyResolver } = require('../../src/einvoice/tax-policy-resolver');

const POLICY_VERSION = '2026-08-17';
const NOW = new Date('2026-08-17T12:00:00.000Z');

function product(overrides = {}) {
  return {
    code: 'SKU-HEALTH-01',
    uqc: 'OTH',
    supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
    allowedZeroRateReason: 'VATEX-SA-HEA',
    ...overrides,
  };
}

function eligibility(overrides = {}) {
  return {
    governmentBorneVatEligible: true,
    reasonCode: 'VATEX-SA-HEA',
    evidenceReference: 'event-synthetic-hea-1',
    verifiedAt: '2026-08-17T10:00:00.000Z',
    buyerName: 'Synthetic Citizen',
    buyerNationalId: '1000000000',
    ...overrides,
  };
}

function zeroFinancials(overrides = {}) {
  return {
    netAmount: '267.00',
    taxRate: '0.00',
    taxAmount: '0.00',
    paidAmount: '267.00',
    ...overrides,
  };
}

function standardFinancials(overrides = {}) {
  return {
    netAmount: '100.00',
    taxRate: '15.00',
    taxAmount: '15.00',
    paidAmount: '115.00',
    ...overrides,
  };
}

function resolver() {
  return createTaxPolicyResolver({ policyVersion: POLICY_VERSION, now: () => NOW });
}

function transparentProxy(value) {
  const counter = { calls: 0 };
  const count = operation => (...args) => {
    counter.calls += 1;
    return Reflect[operation](...args);
  };
  return {
    counter,
    value: new Proxy(value, {
      get: count('get'),
      getOwnPropertyDescriptor: count('getOwnPropertyDescriptor'),
      getPrototypeOf: count('getPrototypeOf'),
      has: count('has'),
      ownKeys: count('ownKeys'),
    }),
  };
}

function expectSafeFailure(operation, counter, code, message) {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(expect.objectContaining({ code, message, retryable: false }));
  expect(counter.calls).toBe(0);
}

test('resolves an eligible healthcare product to the frozen HEA decision', () => {
  const result = resolver().resolveLineTax({
    product: product(), eligibility: eligibility(), financialBreakup: zeroFinancials(),
  });

  expect(result).toEqual({
    category: 'Z',
    rate: '0.00',
    reasonCode: 'VATEX-SA-HEA',
    reasonText: 'Private healthcare to citizen',
    policyVersion: POLICY_VERSION,
    evidenceReference: 'event-synthetic-hea-1',
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
});

test('resolves an explicit false decision to the frozen standard-rate result', () => {
  const result = resolver().resolveLineTax({
    product: product(),
    eligibility: eligibility({
      governmentBorneVatEligible: false,
      reasonCode: null,
      buyerName: null,
      buyerNationalId: null,
    }),
    financialBreakup: standardFinancials(),
  });

  expect(result).toEqual({
    category: 'S', rate: '15.00', reasonCode: null, reasonText: null,
    policyVersion: POLICY_VERSION, evidenceReference: 'event-synthetic-hea-1',
  });
  expect(Object.isFrozen(result)).toBe(true);
});

test('accepts independently optional valid recipient identity for a standard-rate decision', () => {
  for (const candidate of [
    eligibility({
      governmentBorneVatEligible: false, reasonCode: null,
      buyerName: 'Standard Buyer', buyerNationalId: null,
    }),
    eligibility({
      governmentBorneVatEligible: false, reasonCode: null,
      buyerName: null, buyerNationalId: '1999999999',
    }),
  ]) {
    expect(resolver().resolveLineTax({
      product: product(), eligibility: candidate, financialBreakup: standardFinancials(),
    })).toEqual(expect.objectContaining({ category: 'S', rate: '15.00' }));
  }
});

test.each([
  ['blank optional name', '   ', null],
  ['control-bearing optional name', 'Private\nName', null],
  ['non-ASCII optional National ID', null, '١٩٩٩٩٩٩٩٩٩'],
  ['wrong-length optional National ID', null, '199999999'],
])('rejects a standard-rate decision with %s', (_description, buyerName, buyerNationalId) => {
  expect(() => resolver().resolveLineTax({
    product: product(),
    eligibility: eligibility({
      governmentBorneVatEligible: false, reasonCode: null, buyerName, buyerNationalId,
    }),
    financialBreakup: standardFinancials(),
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_IDENTITY_REQUIRED' }));
});

test.each([
  ['missing', eligibility({ governmentBorneVatEligible: undefined })],
  ['null', eligibility({ governmentBorneVatEligible: null })],
  ['string', eligibility({ governmentBorneVatEligible: 'true' })],
  ['inherited', Object.assign(Object.create({ governmentBorneVatEligible: true }), {
    reasonCode: 'VATEX-SA-HEA', evidenceReference: 'event-synthetic-hea-1',
    verifiedAt: '2026-08-17T10:00:00.000Z', buyerName: 'Synthetic Citizen', buyerNationalId: '1000000000',
  })],
])('holds a %s eligibility decision with a safe deterministic code', (_case, candidate) => {
  expect(() => resolver().resolveLineTax({
    product: product(), eligibility: candidate, financialBreakup: zeroFinancials(),
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_DECISION_REQUIRED' }));
});

test.each([
  ['wrong reason', eligibility({ reasonCode: null })],
  ['missing evidence', eligibility({ evidenceReference: null })],
  ['invalid timestamp', eligibility({ verifiedAt: null })],
  ['future timestamp', eligibility({ verifiedAt: '2026-08-18T10:00:00.000Z' })],
])('holds eligible input with %s without exposing evidence values', (_case, candidate) => {
  let caught;
  try {
    resolver().resolveLineTax({
      product: product(), eligibility: candidate, financialBreakup: zeroFinancials(),
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(expect.objectContaining({ code: 'TAX_ELIGIBILITY_EVIDENCE_INVALID' }));
  expect(`${caught.message} ${caught.code}`).not.toContain('event-synthetic');
  expect(`${caught.message} ${caught.code}`).not.toContain('2026-08-18');
});

test.each([
  ['23:59:59.999 old', '2026-08-16T12:00:00.001Z'],
  ['exactly 24 hours old', '2026-08-16T12:00:00.000Z'],
])('accepts eligibility evidence that is %s', (_description, verifiedAt) => {
  expect(resolver().resolveLineTax({
    product: product(),
    eligibility: eligibility({ verifiedAt }),
    financialBreakup: zeroFinancials(),
  })).toEqual(expect.objectContaining({ category: 'Z', rate: '0.00' }));
});

test.each([
  ['24 hours plus one millisecond old', '2026-08-16T11:59:59.999Z'],
  ['ancient', '2000-01-01T00:00:00.000Z'],
  ['one millisecond in the future', '2026-08-17T12:00:00.001Z'],
])('rejects %s eligibility evidence with one fixed safe error', (_description, verifiedAt) => {
  let caught;
  try {
    resolver().resolveLineTax({
      product: product(),
      eligibility: eligibility({ verifiedAt }),
      financialBreakup: zeroFinancials(),
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({
    code: 'TAX_ELIGIBILITY_EVIDENCE_INVALID',
    message: 'Healthcare tax eligibility evidence is invalid',
    retryable: false,
  }));
  expect(`${caught.code} ${caught.message}`).not.toContain(verifiedAt);
});

test.each([
  ['missing name', eligibility({ buyerName: null })],
  ['blank name', eligibility({ buyerName: '   ' })],
  ['missing National ID', eligibility({ buyerNationalId: null })],
  ['non-ASCII National ID', eligibility({ buyerNationalId: '١٠٠٠٠٠٠٠٠٠' })],
  ['wrong-length National ID', eligibility({ buyerNationalId: '100000000' })],
])('holds eligible input with %s and never includes identity in the error', (_case, candidate) => {
  let caught;
  try {
    resolver().resolveLineTax({
      product: product(), eligibility: candidate, financialBreakup: zeroFinancials(),
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(expect.objectContaining({ code: 'TAX_ELIGIBILITY_IDENTITY_REQUIRED' }));
  expect(`${caught.message} ${caught.code}`).not.toContain('Synthetic Citizen');
  expect(`${caught.message} ${caught.code}`).not.toContain('100000000');
});

test.each([
  product({ supplyClass: 'MEDICINE' }),
  product({ allowedZeroRateReason: 'VATEX-SA-35' }),
  product({ uqc: 'PCE' }),
  Object.assign(Object.create({ supplyClass: 'PRIVATE_HEALTHCARE_SERVICE' }), {
    code: 'SKU-HEALTH-01', uqc: 'OTH', allowedZeroRateReason: 'VATEX-SA-HEA',
  }),
])('holds unsupported or inherited product classification', candidate => {
  expect(() => resolver().resolveLineTax({
    product: candidate, eligibility: eligibility(), financialBreakup: zeroFinancials(),
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_PRODUCT_UNSUPPORTED' }));
});

test.each([
  ['true with 15 percent', eligibility(), standardFinancials()],
  ['true with nonzero tax', eligibility(), zeroFinancials({ taxAmount: '0.01', paidAmount: '267.01' })],
  ['false with zero percent', eligibility({ governmentBorneVatEligible: false, reasonCode: null, buyerName: null, buyerNationalId: null }), zeroFinancials()],
  ['false with bad tax', eligibility({ governmentBorneVatEligible: false, reasonCode: null, buyerName: null, buyerNationalId: null }), standardFinancials({ taxAmount: '14.98', paidAmount: '114.98' })],
  ['false with paid drift', eligibility({ governmentBorneVatEligible: false, reasonCode: null, buyerName: null, buyerNationalId: null }), standardFinancials({ paidAmount: '115.02' })],
])('holds a financial mismatch: %s', (_case, candidateEligibility, financialBreakup) => {
  expect(() => resolver().resolveLineTax({
    product: product(), eligibility: candidateEligibility, financialBreakup,
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH' }));
});

test.each([
  ['one halala below net', '266.99'],
  ['exactly net', '267.00'],
  ['one halala above net', '267.01'],
])('accepts an eligible Z/0 line paid %s without altering its zero-tax decision', (_description, paidAmount) => {
  expect(resolver().resolveLineTax({
    product: product(),
    eligibility: eligibility(),
    financialBreakup: zeroFinancials({ paidAmount }),
  })).toEqual(expect.objectContaining({ category: 'Z', rate: '0.00' }));
});

test.each([
  ['two halala below net', '266.98'],
  ['two halala above net', '267.02'],
])('rejects an eligible Z/0 line paid %s', (_description, paidAmount) => {
  expect(() => resolver().resolveLineTax({
    product: product(),
    eligibility: eligibility(),
    financialBreakup: zeroFinancials({ paidAmount }),
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH' }));
});

test('accepts a one-halala standard tax rounding difference but not two', () => {
  const ineligible = eligibility({
    governmentBorneVatEligible: false, reasonCode: null, buyerName: null, buyerNationalId: null,
  });
  expect(resolver().resolveLineTax({
    product: product(), eligibility: ineligible,
    financialBreakup: standardFinancials({ taxAmount: '14.99', paidAmount: '114.99' }),
  })).toEqual(expect.objectContaining({ category: 'S', rate: '15.00' }));
  expect(() => resolver().resolveLineTax({
    product: product(), eligibility: ineligible,
    financialBreakup: standardFinancials({ taxAmount: '14.98', paidAmount: '114.98' }),
  })).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH' }));
});

test.each([
  [{ policyVersion: '2026-08-18', now: () => NOW }],
  [{ policyVersion: POLICY_VERSION, now: null }],
])('rejects unsupported resolver configuration', options => {
  expect(() => createTaxPolicyResolver(options))
    .toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_POLICY_INVALID' }));
});

test.each([
  ['resolver input', ({ value }) => value, 'TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required'],
  ['product', ({ value }, input) => ({ ...input, product: value }), 'TAX_ELIGIBILITY_PRODUCT_UNSUPPORTED', 'Healthcare product classification is unsupported'],
  ['eligibility', ({ value }, input) => ({ ...input, eligibility: value }), 'TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required'],
  ['financial breakup', ({ value }, input) => ({ ...input, financialBreakup: value }), 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile'],
])('rejects a transparent Proxy %s without executing any trap', (_description, place, code, message) => {
  const input = {
    product: product(), eligibility: eligibility(), financialBreakup: zeroFinancials(),
  };
  const target = _description === 'resolver input'
    ? input
    : input[_description === 'financial breakup' ? 'financialBreakup' : _description];
  const tracked = transparentProxy(target);

  expectSafeFailure(
    () => resolver().resolveLineTax(place(tracked, input)),
    tracked.counter,
    code,
    message,
  );
});

test('rejects a transparent Proxy resolver configuration without executing any trap', () => {
  const tracked = transparentProxy({ policyVersion: POLICY_VERSION, now: () => NOW });

  expectSafeFailure(
    () => createTaxPolicyResolver(tracked.value),
    tracked.counter,
    'TAX_ELIGIBILITY_POLICY_INVALID',
    'Healthcare tax policy configuration is invalid',
  );
});

test.each([
  ['input product', 'TAX_ELIGIBILITY_PRODUCT_UNSUPPORTED', 'Healthcare product classification is unsupported', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input, 'product', {
      enumerable: true,
      get() { counter.calls += 1; return product(); },
    });
    return counter;
  }],
  ['product uqc', 'TAX_ELIGIBILITY_PRODUCT_UNSUPPORTED', 'Healthcare product classification is unsupported', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input.product, 'uqc', {
      enumerable: true,
      get() { counter.calls += 1; return 'OTH'; },
    });
    return counter;
  }],
  ['input eligibility', 'TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input, 'eligibility', {
      enumerable: true,
      get() { counter.calls += 1; return eligibility(); },
    });
    return counter;
  }],
  ['eligibility decision', 'TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input.eligibility, 'governmentBorneVatEligible', {
      enumerable: true,
      get() { counter.calls += 1; return true; },
    });
    return counter;
  }],
  ['input financial breakup', 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input, 'financialBreakup', {
      enumerable: true,
      get() { counter.calls += 1; return zeroFinancials(); },
    });
    return counter;
  }],
  ['financial net amount', 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile', input => {
    const counter = { calls: 0 };
    Object.defineProperty(input.financialBreakup, 'netAmount', {
      enumerable: true,
      get() { counter.calls += 1; return '267.00'; },
    });
    return counter;
  }],
])('rejects accessor %s without invoking it', (_description, code, message, addAccessor) => {
  const input = {
    product: product(), eligibility: eligibility(), financialBreakup: zeroFinancials(),
  };
  const counter = addAccessor(input);

  expectSafeFailure(
    () => resolver().resolveLineTax(input),
    counter,
    code,
    message,
  );
});

test.each([
  ['inherited', Object.assign(Object.create({ marker: true }), {
    product: product(), eligibility: eligibility(), financialBreakup: zeroFinancials(),
  })],
  ['array', Object.assign([], {
    product: product(), eligibility: eligibility(), financialBreakup: zeroFinancials(),
  })],
  ['class instance', new (class ResolverInput {
    constructor() {
      this.product = product();
      this.eligibility = eligibility();
      this.financialBreakup = zeroFinancials();
    }
  })()],
])('rejects a non-plain %s resolver input with one safe error', (_description, input) => {
  expect(() => resolver().resolveLineTax(input)).toThrow(expect.objectContaining({
    code: 'TAX_ELIGIBILITY_DECISION_REQUIRED',
    message: 'Healthcare tax eligibility decision is required',
  }));
});

test.each([
  ['inherited', Object.assign(Object.create({ netAmount: '267.00' }), {
    taxRate: '0.00', taxAmount: '0.00', paidAmount: '267.00',
  })],
  ['array', Object.assign([], zeroFinancials())],
  ['class instance', new (class FinancialBreakup {
    constructor() { Object.assign(this, zeroFinancials()); }
  })()],
])('rejects a non-plain %s financial breakup with one safe error', (_description, financialBreakup) => {
  expect(() => resolver().resolveLineTax({
    product: product(), eligibility: eligibility(), financialBreakup,
  })).toThrow(expect.objectContaining({
    code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH',
    message: 'Healthcare tax financials do not reconcile',
  }));
});
