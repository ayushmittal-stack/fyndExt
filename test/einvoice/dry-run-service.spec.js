'use strict';

const crypto = require('crypto');

const { EinvoiceError } = require('../../src/einvoice/errors');
const { OEIS_UPDATE_PATH } = require('../../src/einvoice/clients/oeis-client');
const { createDryRunService } = require('../../src/einvoice/dry-run-service');

const COMPANY_ID = 'company-1';
const JOB_ID = 42;
const SHIPMENT_ID = '17861361389811907489';
const DOCUMENT_NUMBER = 'VR-17861361389811907489-1';
const BASE_URL = "https://oeis.example.test/root'quoted";
const UPDATE_URL = `${BASE_URL}/API/V2/Transaction/UpdateInvoiceData`;
const CREATED_AT = '2026-08-13T09:59:58.000Z';
const LOCKED_AT = '2026-08-13T10:00:00.000Z';
const UPDATED_AT = LOCKED_AT;
const BUYER_NAME = 'SENTINEL BUYER 8A';
const BUYER_NATIONAL_ID = '1098765432';
const REQUEST_JSON = `[{"TRAN_DOC_NO":"${DOCUMENT_NUMBER}","NOTE":"رياض","CUST_NAME_WALKIN":"${BUYER_NAME}","CUST_ADDITIONAL_ID_NO_WALKIN":"${BUYER_NATIONAL_ID}"}]`;

function hash(value = REQUEST_JSON) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshot(overrides = {}) {
  return {
    shipmentId: SHIPMENT_ID,
    confirmedAt: '2026-08-13T09:59:57.000Z',
    branchCode: 'R1',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '115.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: true,
      reasonCode: 'VATEX-SA-HEA',
      evidenceReference: 'event-evidence-8a',
      verifiedAt: '2026-08-13T09:59:57.000Z',
      buyerName: BUYER_NAME,
      buyerNationalId: BUYER_NATIONAL_ID,
    },
    bags: [{
      bagId: 'bag-1',
      lineNumber: 1,
      productCode: 'SKU-1',
      quantity: 1,
      financialBreakup: {
        price_effective: '115.00',
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '0.00',
        value_of_good: '100.00',
        gst_tax_percentage: '15.00',
        gst_fee: '15.00',
        amount_paid: '115.00',
      },
      prices: {
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '0.00',
      },
      customer: { email: 'customer@example.test' },
    }],
    customer: { name: 'Customer Name', phone: '+966500000000' },
    deliveryAddress: { line1: 'Private address' },
    ...overrides,
  };
}

function heldJob(overrides = {}) {
  return {
    id: JOB_ID,
    companyId: COMPANY_ID,
    applicationId: 'application-secret',
    shipmentId: SHIPMENT_ID,
    documentType: 'sales_invoice',
    documentNumber: DOCUMENT_NUMBER,
    state: 'SUBMISSION_HELD',
    shipmentSnapshot: snapshot(),
    oeisRequestJson: REQUEST_JSON,
    oeisRequest: [{ TRAN_DOC_NO: DOCUMENT_NUMBER, NOTE: 'رياض' }],
    requestHash: hash(),
    attemptCount: 7,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: 'SECRET_VENDOR_CODE',
    lastErrorMessage: 'private downstream response',
    lockedAt: LOCKED_AT,
    version: 4,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function listPage(overrides = {}) {
  return {
    items: [{
      jobId: JOB_ID,
      shipmentId: SHIPMENT_ID,
      documentNumber: DOCUMENT_NUMBER,
      state: 'SUBMISSION_HELD',
      lockedAt: LOCKED_AT,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      version: 4,
      companyId: COMPANY_ID,
      customer: { name: 'Customer Name' },
      lastErrorMessage: 'private downstream response',
    }],
    nextBeforeId: null,
    rawRequest: REQUEST_JSON,
    ...overrides,
  };
}

function fakeRepository({ page = listPage(), job = heldJob(), request } = {}) {
  return {
    listDryRunJobsForCompany: jest.fn().mockResolvedValue(page),
    listFailedJobsForCompany: jest.fn().mockResolvedValue({ items: [], nextBeforeId: null }),
    getDryRunJobForCompany: jest.fn().mockResolvedValue(job),
    getDryRunRequestForCompany: jest.fn().mockResolvedValue(request === undefined ? {
      jobId: JOB_ID,
      documentNumber: DOCUMENT_NUMBER,
      requestJson: REQUEST_JSON,
      requestHash: hash(),
      secret: 'do-not-return',
    } : request),
  };
}

function failedRow(overrides = {}) {
  return {
    jobId: 51,
    shipmentId: 'shipment-failed-51',
    documentNumber: 'VR-shipment-failed-51-1',
    state: 'DATA_FAILED',
    attemptCount: 3,
    lastErrorCode: 'LOCAL_VALIDATION_FAILED',
    lockedAt: null,
    createdAt: '2026-08-13T09:00:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    version: 4,
    ...overrides,
  };
}

function makeService(repository = fakeRepository(), overrides = {}) {
  return {
    repository,
    service: createDryRunService({
      repository,
      oeisBaseUrl: BASE_URL,
      maxRequestBytes: Buffer.byteLength(REQUEST_JSON, 'utf8'),
      ...overrides,
    }),
  };
}

test('projects only allowlisted held metadata and passes an own-data query to the repository', async () => {
  const { repository, service } = makeService();

  await expect(service.listDryRuns({ companyId: COMPANY_ID, limit: 20, beforeId: null }))
    .resolves.toEqual({
      items: [{
        jobId: 42,
        shipmentId: '17861361389811907489',
        documentNumber: 'VR-17861361389811907489-1',
        state: 'SUBMISSION_HELD',
        lockedAt: '2026-08-13T10:00:00.000Z',
        createdAt: '2026-08-13T09:59:58.000Z',
        updatedAt: '2026-08-13T10:00:00.000Z',
        version: 4,
      }],
      nextBeforeId: null,
    });
  expect(repository.listDryRunJobsForCompany).toHaveBeenCalledWith({
    companyId: COMPANY_ID, limit: 20, beforeId: null,
  });
});

test('builds the exact safe held journey from validated persisted bytes', async () => {
  const { repository, service } = makeService();

  const result = await service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID });

  expect(repository.getDryRunJobForCompany).toHaveBeenCalledWith({ companyId: COMPANY_ID, jobId: 42 });
  expect(result).toEqual({
    schemaVersion: 1,
    mode: 'dry-run',
    job: {
      jobId: 42,
      shipmentId: '17861361389811907489',
      documentNumber: 'VR-17861361389811907489-1',
      state: 'SUBMISSION_HELD',
      lockedAt: '2026-08-13T10:00:00.000Z',
      version: 4,
    },
    normalizedSnapshot: {
      shipmentId: '17861361389811907489',
      confirmedAt: '2026-08-13T09:59:57.000Z',
      branchCode: 'R1',
      currency: 'SAR',
      paymentMode: 'CARD',
      amountPaid: '115.00',
      policyVersion: '2026-08-17',
      taxEligibility: {
        governmentBorneVatEligible: true,
        reasonCode: 'VATEX-SA-HEA',
        evidenceReference: 'event-evidence-8a',
        verifiedAt: '2026-08-13T09:59:57.000Z',
      },
      bags: [{
        bagId: 'bag-1',
        lineNumber: 1,
        productCode: 'SKU-1',
        quantity: 1,
        financialBreakup: {
          price_effective: '115.00',
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
          value_of_good: '100.00',
          gst_tax_percentage: '15.00',
          gst_fee: '15.00',
          amount_paid: '115.00',
        },
        prices: {
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
        },
      }],
    },
    steps: {
      webhook: {
        status: 'completed',
        event: 'application/shipment/update/v1',
        triggerStatus: 'bag_confirmed',
      },
      payloadPreparation: {
        status: 'completed',
        requestHash: hash(),
        requestBytes: Buffer.byteLength(REQUEST_JSON, 'utf8'),
        withinLimit: true,
      },
      fyndLock: {
        status: 'completed',
        source: 'derived-with-live-builder',
        operation: 'platform.order.updateShipmentLock',
        request: {
          body: {
            entity_type: 'shipments',
            action: 'lock',
            action_type: 'complete',
            entities: [{
              id: '17861361389811907489',
              reason_text: 'OEIS invoice VR-17861361389811907489-1',
            }],
          },
        },
        result: { locked: true },
      },
      oeisSubmission: {
        status: 'held',
        method: 'POST',
        url: UPDATE_URL,
        bodyDownloadUrl: '/api/einvoice/dry-runs/42/oeis-request',
        bodyFileName: 'VR-17861361389811907489-1-oeis-diagnostic.json',
        sanitized: true,
        warning: 'Sanitized diagnostic only; it is not valid for OEIS submission.',
      },
      fyndTransition: {
        status: 'blocked',
        operation: 'platform.order.updateShipmentStatus',
        executable: false,
        requestTemplate: {
          body: {
            task: false,
            force_transition: false,
            unlock_before_transition: true,
            lock_after_transition: false,
            statuses: [{
              status: 'bag_invoiced',
              shipments: [{
                identifier: '17861361389811907489',
                products: [],
                data_updates: {
                  products: [{ data: { store_invoice_id: 'VR-17861361389811907489-1' } }],
                  entities: [{
                    data: {
                      store_invoice_id: 'VR-17861361389811907489-1',
                      meta: {
                        einvoice_info: {
                          SignedQRCode: { $deferred: 'ReportingApiResponse.SignedXmlEncoded' },
                        },
                        shipment_meta: {
                          xml: {
                            content: { $deferred: 'decoded ReportingApiResponse.SignedXmlEncoded' },
                            filename: 'VR-17861361389811907489-1.xml',
                          },
                        },
                      },
                    },
                  }],
                },
              }],
            }],
          },
        },
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain(REQUEST_JSON);
  expect(JSON.stringify(result)).not.toContain('Customer Name');
  expect(JSON.stringify(result)).not.toContain('Private address');
  expect(JSON.stringify(result)).not.toContain('customer@example.test');
  expect(JSON.stringify(result)).not.toContain('SECRET_VENDOR_CODE');
  expect(JSON.stringify(result)).not.toContain('private downstream response');
  expect(result.steps.oeisSubmission).not.toHaveProperty('curl');
});

test('uses exact UTF-8 bytes at the configured request limit', async () => {
  const exactBytes = Buffer.byteLength(REQUEST_JSON, 'utf8');
  expect(REQUEST_JSON.length).toBeLessThan(exactBytes);
  const { service } = makeService(fakeRepository(), { maxRequestBytes: exactBytes });
  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .resolves.toHaveProperty('steps.payloadPreparation', {
      status: 'completed', requestHash: hash(), requestBytes: exactBytes, withinLimit: true,
    });
});

test('preserves a valid normalized snapshot with only one optional price field', async () => {
  const storedSnapshot = snapshot();
  storedSnapshot.bags[0].prices = { promotion_effective_discount: '0.00' };
  const { service } = makeService(fakeRepository({
    job: heldJob({ shipmentSnapshot: storedSnapshot }),
  }));

  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .resolves.toHaveProperty('normalizedSnapshot.bags.0.prices', {
      promotion_effective_discount: '0.00',
    });
});

test('preserves normalized delivery evidence in a held dry-run journey', async () => {
  const storedSnapshot = snapshot({
    amountPaid: '149.50',
    deliveryCharge: {
      taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
    },
  });
  storedSnapshot.bags[0].financialBreakup.amount_paid = '149.50';
  storedSnapshot.bags[0].financialBreakup.delivery_charge = '30.00';
  const { service } = makeService(fakeRepository({
    job: heldJob({ shipmentSnapshot: storedSnapshot }),
  }));

  const journey = await service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID });

  expect(journey.normalizedSnapshot.deliveryCharge).toEqual({
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  });
  expect(journey.normalizedSnapshot.bags[0].financialBreakup.delivery_charge).toBe('30.00');
});

test('rejects an accessor-backed repository snapshot array with the safe corruption error', async () => {
  const storedSnapshot = snapshot();
  const unsafeBags = [];
  Object.defineProperty(unsafeBags, '0', {
    configurable: true,
    enumerable: true,
    get() { throw new Error('private bag getter error'); },
  });
  unsafeBags.length = 1;
  storedSnapshot.bags = unsafeBags;
  const { service } = makeService(fakeRepository({
    job: heldJob({ shipmentSnapshot: storedSnapshot }),
  }));

  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
});

test.each([
  ['malformed JSON', heldJob({ oeisRequestJson: '{', requestHash: hash('{') })],
  ['empty row array', (() => { const value = '[]'; return heldJob({ oeisRequestJson: value, requestHash: hash(value) }); })()],
  ['wrong hash', heldJob({ requestHash: '0'.repeat(64) })],
  ['wrong row document', (() => {
    const value = '[{"TRAN_DOC_NO":"VR-other-1"}]';
    return heldJob({ oeisRequestJson: value, requestHash: hash(value) });
  })()],
  ['mixed row documents', (() => {
    const value = `[{"TRAN_DOC_NO":"${DOCUMENT_NUMBER}"},{"TRAN_DOC_NO":"VR-other-1"}]`;
    return heldJob({ oeisRequestJson: value, requestHash: hash(value) });
  })()],
  ['inherited row document', (() => {
    const value = '[{}]';
    return heldJob({ oeisRequestJson: value, requestHash: hash(value) });
  })()],
  ['oversized UTF-8 bytes', heldJob()],
])('fails closed with one sanitized corruption error for %s', async (description, job) => {
  const maxRequestBytes = description === 'oversized UTF-8 bytes'
    ? Buffer.byteLength(REQUEST_JSON, 'utf8') - 1
    : Buffer.byteLength(REQUEST_JSON, 'utf8');
  const { service } = makeService(fakeRepository({ job }), { maxRequestBytes });

  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      name: 'EinvoiceError', code: 'DRY_RUN_DATA_INVALID', retryable: false,
      message: 'Dry-run data is invalid',
    }));
});

test.each([
  ['missing', null],
  ['foreign-shaped', heldJob({ companyId: 'company-2' })],
  ['nonheld-shaped', heldJob({ state: 'LOCKED' })],
])('returns the same sanitized not-found error for a %s detail record', async (_description, job) => {
  const { service } = makeService(fakeRepository({ job }));
  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      name: 'EinvoiceError', code: 'DRY_RUN_NOT_FOUND', retryable: false,
      message: 'Dry-run job was not found',
    }));
});

test('returns deterministic sanitized diagnostic bytes without mutating stored request bytes or hash', async () => {
  const { repository, service } = makeService();
  const beforeJson = repository.getDryRunRequestForCompany.mock.results;
  await expect(service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID })).resolves.toEqual({
    rawJson: `[{"TRAN_DOC_NO":"${DOCUMENT_NUMBER}","NOTE":"رياض","CUST_NAME_WALKIN":"<redacted>","CUST_ADDITIONAL_ID_NO_WALKIN":"<redacted>"}]`,
    filename: 'VR-17861361389811907489-1-oeis-diagnostic.json',
    contentType: 'application/json',
    sanitized: true,
  });
  expect(repository.getDryRunRequestForCompany).toHaveBeenCalledWith({ companyId: COMPANY_ID, jobId: 42 });
  const stored = await repository.getDryRunRequestForCompany.mock.results[0].value;
  expect(stored.requestJson).toBe(REQUEST_JSON);
  expect(stored.requestHash).toBe(hash());
  expect(beforeJson).toBe(repository.getDryRunRequestForCompany.mock.results);
  expect(JSON.stringify(await service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID })))
    .not.toMatch(new RegExp(`${BUYER_NAME}|${BUYER_NATIONAL_ID}`));
});

test('redacts both buyer fields in every diagnostic row while preserving non-identity fields', async () => {
  const requestJson = JSON.stringify([
    { TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_NAME_WALKIN: BUYER_NAME, CUST_ADDITIONAL_ID_NO_WALKIN: BUYER_NATIONAL_ID, TRAN_TAX_CODE_CATEGORY: 'Z' },
    { TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_NAME_WALKIN: `${BUYER_NAME}-2`, CUST_ADDITIONAL_ID_NO_WALKIN: '1000000000', TRAN_TAX_RATE: '0.00' },
  ]);
  const request = { jobId: JOB_ID, documentNumber: DOCUMENT_NUMBER, requestJson, requestHash: hash(requestJson) };
  const { service } = makeService(fakeRepository({ request }), { maxRequestBytes: Buffer.byteLength(requestJson) });

  const result = await service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID });

  expect(JSON.parse(result.rawJson)).toEqual([
    { TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_NAME_WALKIN: '<redacted>', CUST_ADDITIONAL_ID_NO_WALKIN: '<redacted>', TRAN_TAX_CODE_CATEGORY: 'Z' },
    { TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_NAME_WALKIN: '<redacted>', CUST_ADDITIONAL_ID_NO_WALKIN: '<redacted>', TRAN_TAX_RATE: '0.00' },
  ]);
});

test('preserves validated JSON keys that collide with object prototype names during redaction', async () => {
  const requestJson = `[{"TRAN_DOC_NO":"${DOCUMENT_NUMBER}","__proto__":"preserved","constructor":"also-preserved","CUST_NAME_WALKIN":"${BUYER_NAME}"}]`;
  const request = { jobId: JOB_ID, documentNumber: DOCUMENT_NUMBER, requestJson, requestHash: hash(requestJson) };
  const { service } = makeService(fakeRepository({ request }), { maxRequestBytes: Buffer.byteLength(requestJson) });

  const result = await service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID });

  expect(result.rawJson).toBe(`[{"TRAN_DOC_NO":"${DOCUMENT_NUMBER}","__proto__":"preserved","constructor":"also-preserved","CUST_NAME_WALKIN":"<redacted>"}]`);
});

test.each([
  ['nested object buyer name', {
    PRIVATE_DETAIL: { CUST_NAME_WALKIN: `${BUYER_NAME}-NESTED` },
  }],
  ['nested array buyer national ID', {
    PRIVATE_DETAIL: [{ CUST_ADDITIONAL_ID_NO_WALKIN: BUYER_NATIONAL_ID }],
  }],
  ['unrelated object-valued field', { PRIVATE_DETAIL: { harmless: 'but not flat' } }],
  ['unrelated array-valued field', { PRIVATE_DETAIL: ['not', 'flat'] }],
])('fails closed without leaking sentinel values for a flat-contract violation: %s', async (_description, extra) => {
  const requestJson = JSON.stringify([{ TRAN_DOC_NO: DOCUMENT_NUMBER, ...extra }]);
  const request = { jobId: JOB_ID, documentNumber: DOCUMENT_NUMBER, requestJson, requestHash: hash(requestJson) };
  const repository = fakeRepository({ request });
  const { service } = makeService(repository, { maxRequestBytes: Buffer.byteLength(requestJson) });

  const error = await service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID })
    .catch(value => value);

  expect(error).toEqual(expect.objectContaining({
    code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
  }));
  expect(JSON.stringify(error)).not.toMatch(new RegExp(`${BUYER_NAME}|${BUYER_NATIONAL_ID}|NESTED`));
  const stored = await repository.getDryRunRequestForCompany.mock.results[0].value;
  expect(stored.requestJson).toBe(requestJson);
  expect(stored.requestHash).toBe(hash(requestJson));
});

test.each([
  ['failure items', repository => {
    repository.listFailedJobsForCompany.mockResolvedValue({
      items: new Proxy([failedRow()], {}), nextBeforeId: null,
    });
    return repository;
  }, service => service.listDryRunFailures({ companyId: COMPANY_ID, limit: 20, beforeId: null })],
  ['journey bags', repository => {
    const job = heldJob();
    job.shipmentSnapshot.bags = new Proxy(job.shipmentSnapshot.bags, {});
    repository.getDryRunJobForCompany.mockResolvedValue(job);
    return repository;
  }, service => service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID })],
])('rejects a transparent Proxy %s container with the fixed corruption error', async (
  _description,
  arrange,
  invoke,
) => {
  const repository = arrange(fakeRepository());
  const { service } = makeService(repository);
  await expect(invoke(service)).rejects.toEqual(expect.objectContaining({
    code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
  }));
});

test.each([
  ['array row', JSON.stringify([[DOCUMENT_NUMBER]])],
  ['null buyer name', JSON.stringify([{ TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_NAME_WALKIN: null }])],
  ['object buyer national ID', JSON.stringify([{ TRAN_DOC_NO: DOCUMENT_NUMBER, CUST_ADDITIONAL_ID_NO_WALKIN: {} }])],
])('fails closed before diagnostic serialization for malformed %s', async (_description, requestJson) => {
  const request = { jobId: JOB_ID, documentNumber: DOCUMENT_NUMBER, requestJson, requestHash: hash(requestJson) };
  const { service } = makeService(fakeRepository({ request }), { maxRequestBytes: Buffer.byteLength(requestJson) });
  await expect(service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
});

test('projects frozen summary-only terminal failures using only service-owned messages', async () => {
  const repository = fakeRepository();
  repository.listFailedJobsForCompany.mockResolvedValue({
    items: [
      failedRow(),
      failedRow({ jobId: 50, state: 'INDETERMINATE', lastErrorCode: 'OEIS_UNKNOWN_RESULT', lockedAt: LOCKED_AT }),
      failedRow({ jobId: 49, lastErrorCode: 'UNKNOWN_PRIVATE_CODE' }),
    ],
    nextBeforeId: 49,
  });
  const { service } = makeService(repository);

  const result = await service.listDryRunFailures({ companyId: COMPANY_ID, limit: 3, beforeId: null });

  expect(result).toEqual({
    items: [
      {
        jobId: 51, shipmentId: 'shipment-failed-51', documentNumber: 'VR-shipment-failed-51-1',
        state: 'DATA_FAILED', failureCode: 'LOCAL_VALIDATION_FAILED',
        failureMessage: 'Invoice data failed local validation.', attemptCount: 3,
        lockRecordedAt: null, createdAt: '2026-08-13T09:00:00.000Z',
        failedAt: '2026-08-13T10:00:00.000Z', version: 4,
      },
      expect.objectContaining({
        jobId: 50, state: 'INDETERMINATE', failureCode: 'OEIS_UNKNOWN_RESULT',
        failureMessage: 'Invoice outcome is indeterminate and requires operator review.',
        lockRecordedAt: LOCKED_AT,
      }),
      expect.objectContaining({
        jobId: 49, failureCode: 'UNKNOWN_PRIVATE_CODE',
        failureMessage: 'Invoice processing failed. Review the failure code.',
      }),
    ],
    nextBeforeId: 49,
  });
  expect(repository.listFailedJobsForCompany).toHaveBeenCalledWith({ companyId: COMPANY_ID, limit: 3, beforeId: null });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.items)).toBe(true);
  expect(result.items.every(Object.isFrozen)).toBe(true);
});

test.each([
  ['extra property', failedRow({ rawRequest: REQUEST_JSON })],
  ['nonterminal state', failedRow({ state: 'SUBMISSION_HELD' })],
  ['unsafe attempt count', failedRow({ attemptCount: Number.MAX_SAFE_INTEGER + 1 })],
  ['invalid failure instant', failedRow({ updatedAt: 'not-an-instant' })],
  ['class row', Object.assign(new (class FailureRow {})(), failedRow())],
  ['proxy row', new Proxy(failedRow(), {})],
])('fails closed on malformed terminal failure repository row: %s', async (_description, row) => {
  const repository = fakeRepository();
  repository.listFailedJobsForCompany.mockResolvedValue({ items: [row], nextBeforeId: null });
  const { service } = makeService(repository);
  await expect(service.listDryRunFailures({ companyId: COMPANY_ID, limit: 20, beforeId: null }))
    .rejects.toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
});

test.each([
  ['missing request', null],
  ['foreign job ID', { jobId: 41, documentNumber: DOCUMENT_NUMBER, requestJson: REQUEST_JSON, requestHash: hash() }],
])('returns the same sanitized not-found error for %s', async (_description, request) => {
  const { service } = makeService(fakeRepository({ request }));
  await expect(service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      code: 'DRY_RUN_NOT_FOUND', message: 'Dry-run job was not found', retryable: false,
    }));
});

test('rejects request corruption before returning any bytes', async () => {
  const request = {
    jobId: JOB_ID,
    documentNumber: DOCUMENT_NUMBER,
    requestJson: REQUEST_JSON,
    requestHash: 'f'.repeat(64),
  };
  const { service } = makeService(fakeRepository({ request }));
  await expect(service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
});

test('snapshots repository return data once and rejects accessors without leaking their errors', async () => {
  const job = heldJob();
  Object.defineProperty(job, 'oeisRequestJson', {
    enumerable: true,
    get() { throw new Error('private repository getter error'); },
  });
  const { service } = makeService(fakeRepository({ job }));
  try {
    await service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID });
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
    expect(error.message).not.toContain('private repository getter error');
    expect(error).toBeInstanceOf(EinvoiceError);
    return;
  }
  throw new Error('Expected unsafe repository record to be rejected');
});

test.each([
  ['journey getPrototypeOf trap', 'journey', 'getPrototypeOf'],
  ['journey descriptor trap', 'journey', 'getOwnPropertyDescriptor'],
  ['download getPrototypeOf trap', 'download', 'getPrototypeOf'],
  ['download descriptor trap', 'download', 'getOwnPropertyDescriptor'],
])('sanitizes a caller-shaped EinvoiceError from a repository %s', async (_description, operation, trap) => {
  const callerError = new EinvoiceError('CALLER_SECRET_CODE', 'private repository trap details');
  const target = operation === 'journey'
    ? heldJob()
    : {
      jobId: JOB_ID,
      documentNumber: DOCUMENT_NUMBER,
      requestJson: REQUEST_JSON,
      requestHash: hash(),
    };
  const record = new Proxy(target, trap === 'getPrototypeOf' ? {
    getPrototypeOf() { throw callerError; },
  } : {
    getOwnPropertyDescriptor(object, property) {
      if (property === (operation === 'journey' ? 'id' : 'jobId')) throw callerError;
      return Reflect.getOwnPropertyDescriptor(object, property);
    },
  });
  const repository = operation === 'journey'
    ? fakeRepository({ job: record })
    : fakeRepository({ request: record });
  const { service } = makeService(repository);

  const promise = operation === 'journey'
    ? service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID })
    : service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID });
  try {
    await promise;
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({
      code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
    }));
    expect(error.code).not.toBe('CALLER_SECRET_CODE');
    expect(JSON.stringify(error)).not.toContain('private repository trap details');
    return;
  }
  throw new Error('Expected repository trap to be rejected');
});

test.each([
  ['journey Symbol hash', 'journey', () => Symbol('private hash')],
  ['journey object hash', 'journey', counter => ({
    toString() { counter.calls += 1; return hash(); },
    valueOf() { counter.calls += 1; return hash(); },
  })],
  ['download Symbol hash', 'download', () => Symbol('private hash')],
  ['download object hash', 'download', counter => ({
    toString() { counter.calls += 1; return hash(); },
    valueOf() { counter.calls += 1; return hash(); },
  })],
])('rejects a non-string own request hash without coercion for %s', async (_description, operation, makeHash) => {
  const counter = { calls: 0 };
  const requestHash = makeHash(counter);
  const repository = operation === 'journey'
    ? fakeRepository({ job: heldJob({ requestHash }) })
    : fakeRepository({ request: {
      jobId: JOB_ID,
      documentNumber: DOCUMENT_NUMBER,
      requestJson: REQUEST_JSON,
      requestHash,
    } });
  const { service } = makeService(repository);
  const promise = operation === 'journey'
    ? service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID })
    : service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID });

  await expect(promise).rejects.toEqual(expect.objectContaining({
    code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false,
  }));
  expect(counter.calls).toBe(0);
});

test.each([
  ['foreign sparse detail', { id: JOB_ID, companyId: 'company-2', state: 'SUBMISSION_HELD' }],
  ['nonheld accessor-protected detail', (() => {
    const value = { id: JOB_ID, companyId: COMPANY_ID, state: 'LOCKED' };
    Object.defineProperty(value, 'oeisRequestJson', {
      get() { throw new Error('unauthorized request getter'); },
    });
    return value;
  })()],
  ['mismatched proxy-protected detail', new Proxy({
    id: JOB_ID + 1,
    companyId: COMPANY_ID,
    state: 'SUBMISSION_HELD',
  }, {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'shipmentSnapshot') throw new Error('unauthorized snapshot descriptor');
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  })],
])('authorizes %s from minimal identity without touching protected fields', async (_description, job) => {
  const { service } = makeService(fakeRepository({ job }));
  const expected = _description.includes('proxy')
    ? { code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false }
    : { code: 'DRY_RUN_NOT_FOUND', message: 'Dry-run job was not found', retryable: false };
  await expect(service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining(expected));
});

test.each([
  ['sparse mismatched download', { jobId: JOB_ID + 1 }],
  ['accessor-protected mismatched download', (() => {
    const value = { jobId: JOB_ID + 1 };
    Object.defineProperty(value, 'requestJson', {
      get() { throw new Error('unauthorized request getter'); },
    });
    return value;
  })()],
  ['proxy-protected mismatched download', new Proxy({ jobId: JOB_ID + 1 }, {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'requestHash') throw new Error('unauthorized hash descriptor');
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  })],
])('authorizes %s from job identity without touching request fields', async (_description, request) => {
  const { service } = makeService(fakeRepository({ request }));
  const expected = _description.includes('proxy')
    ? { code: 'DRY_RUN_DATA_INVALID', message: 'Dry-run data is invalid', retryable: false }
    : { code: 'DRY_RUN_NOT_FOUND', message: 'Dry-run job was not found', retryable: false };
  await expect(service.getDryRunRequest({ companyId: COMPANY_ID, jobId: JOB_ID }))
    .rejects.toEqual(expect.objectContaining(expected));
});

test.each([
  ['username', 'https://user@oeis.example.test/base'],
  ['password', 'https://user:password@oeis.example.test/base'],
  ['query', 'https://oeis.example.test/base?redirect=unsafe'],
  ['fragment', 'https://oeis.example.test/base#unsafe'],
  ['embedded tab', 'https://oeis.exa\tmple.test/base'],
  ['embedded newline', 'https://oeis.example.test/ba\nse'],
  ['surrounding whitespace', ' https://oeis.example.test/base'],
  ['unsupported protocol', 'ftp://oeis.example.test/base'],
])('rejects an OEIS base URL containing %s ambiguity', (_description, oeisBaseUrl) => {
  expect(() => createDryRunService({
    repository: fakeRepository(),
    oeisBaseUrl,
    maxRequestBytes: 1,
  })).toThrow(expect.objectContaining({
    code: 'DRY_RUN_SERVICE_INVALID', message: 'Dry-run service configuration is invalid',
  }));
});

test('canonicalizes the base URL and emits one exact update pathname without search or fragment', async () => {
  const { service } = makeService(fakeRepository(), {
    oeisBaseUrl: 'HTTPS://OEIS.EXAMPLE.TEST:443/root/../base///',
  });
  const result = await service.getDryRunJourney({ companyId: COMPANY_ID, jobId: JOB_ID });
  const updateUrl = new URL(result.steps.oeisSubmission.url);

  expect(result.steps.oeisSubmission.url).toBe(
    'https://oeis.example.test/base/API/V2/Transaction/UpdateInvoiceData',
  );
  expect(updateUrl.pathname).toBe(`/base${OEIS_UPDATE_PATH}`);
  expect(updateUrl.search).toBe('');
  expect(updateUrl.hash).toBe('');
});

test.each([
  ['non-enumerable key', options => {
    Object.defineProperty(options, 'apiKey', { value: 'test-secret' });
  }],
  ['symbol key', options => {
    options[Symbol('api key')] = 'test-secret';
  }],
])('rejects an unknown %s in factory options', (_description, addKey) => {
  const options = {
    repository: fakeRepository(),
    oeisBaseUrl: BASE_URL,
    maxRequestBytes: 1,
  };
  addKey(options);
  expect(() => createDryRunService(options)).toThrow(expect.objectContaining({
    code: 'DRY_RUN_SERVICE_INVALID', retryable: false,
  }));
});

test.each([
  ['missing repository', { repository: null, oeisBaseUrl: BASE_URL, maxRequestBytes: 1 }],
  ['missing held list method', { repository: { ...fakeRepository(), listDryRunJobsForCompany: null }, oeisBaseUrl: BASE_URL, maxRequestBytes: 1 }],
  ['missing failure list method', { repository: { ...fakeRepository(), listFailedJobsForCompany: null }, oeisBaseUrl: BASE_URL, maxRequestBytes: 1 }],
  ['an API key option', { repository: fakeRepository(), oeisBaseUrl: BASE_URL, maxRequestBytes: 1, apiKey: 'test-secret' }],
  ['an invalid base URL', { repository: fakeRepository(), oeisBaseUrl: 'relative/path', maxRequestBytes: 1 }],
  ['an unsafe byte limit', { repository: fakeRepository(), oeisBaseUrl: BASE_URL, maxRequestBytes: Number.MAX_SAFE_INTEGER + 1 }],
])('rejects factory configuration with %s', (_description, options) => {
  expect(() => createDryRunService(options)).toThrow(expect.objectContaining({
    code: 'DRY_RUN_SERVICE_INVALID', retryable: false,
  }));
});

test('rejects inherited and accessor call input before invoking the repository', async () => {
  const repository = fakeRepository();
  const { service } = makeService(repository);
  const inherited = Object.assign(Object.create({ companyId: COMPANY_ID }), { jobId: JOB_ID });
  await expect(service.getDryRunJourney(inherited)).rejects.toEqual(expect.objectContaining({
    code: 'DRY_RUN_REQUEST_INVALID', retryable: false,
  }));
  const accessor = { jobId: JOB_ID };
  Object.defineProperty(accessor, 'companyId', { get() { throw new Error('unsafe input getter'); } });
  await expect(service.getDryRunJourney(accessor)).rejects.toEqual(expect.objectContaining({
    code: 'DRY_RUN_REQUEST_INVALID', retryable: false,
  }));
  expect(repository.getDryRunJobForCompany).not.toHaveBeenCalled();
});
