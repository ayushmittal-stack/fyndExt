'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  buildFyndLockRequest,
  buildFyndTransitionTemplate,
  createFyndShipmentClient,
  toFyndStoreInvoiceId,
} = require('../../src/einvoice/clients/fynd-shipment-client');
const {
  DOCUMENT_NUMBER,
  QR_CODE_DATA,
  SHIPMENT_ID,
  SIGNED_XML,
  SIGNED_XML_BASE64,
  flatTransitionSuccess,
  nestedTransitionSuccess,
  readShipment,
  transitionResult,
} = require('../fixtures/einvoice/fynd');

const COMPANY_ID = 12655;
const OEIS_INVOICE_NUMBER = 'U_IN-119/2026/0000000001';
const OEIS_INVOICE_CODE = 'U-IN-119-2026-0000000001';
const LONG_OEIS_INVOICE_NUMBER = 'OEIS/2026/12345678901234567890';
const LONG_OEIS_INVOICE_CODE = 'OEIS-2026-123456789012345';

function makePlatform({ lockResult = { success: true }, transitionResult: statusResult = nestedTransitionSuccess(), shipmentResult } = {}) {
  return {
    order: {
      updateShipmentLock: jest.fn().mockResolvedValue(lockResult),
      updateShipmentStatus: jest.fn().mockResolvedValue(statusResult),
      getShipmentById: jest.fn().mockResolvedValue(shipmentResult),
    },
  };
}

function makeClient(platform) {
  const getPlatformClient = jest.fn().mockResolvedValue(platform);
  return { client: createFyndShipmentClient({ getPlatformClient }), getPlatformClient };
}

function transitionInput() {
  return {
    companyId: COMPANY_ID,
    shipmentId: SHIPMENT_ID,
    documentNumber: DOCUMENT_NUMBER,
    invoiceNumber: OEIS_INVOICE_NUMBER,
    qrCodeData: QR_CODE_DATA,
    signedXml: SIGNED_XML,
  };
}

function consistentReadShipment(overrides = {}) {
  return readShipment({
    status: { status: 'bag_invoiced', current_shipment_status: 'bag_invoiced' },
    lock_details: { lock_status: false },
    shipment_details: { lock_status: false },
    store_invoice_id: DOCUMENT_NUMBER,
    invoice: { store_invoice_id: DOCUMENT_NUMBER },
    invoice_id: DOCUMENT_NUMBER,
    gst_details: { store_invoice_id: DOCUMENT_NUMBER },
    ...overrides,
  });
}

test('builds fresh exact FDK lock requests from own data', () => {
  const input = { shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER };
  const expected = {
    body: {
      entity_type: 'shipments',
      action: 'lock',
      action_type: 'complete',
      entities: [{
        id: '17861361389811907489',
        reason_text: 'OEIS invoice VR-17861361389811907489-1',
      }],
    },
  };

  const first = buildFyndLockRequest(input);
  const second = buildFyndLockRequest(input);
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(second).not.toBe(first);
  expect(second.body).not.toBe(first.body);
  expect(second.body.entities).not.toBe(first.body.entities);
  expect(second.body.entities[0]).not.toBe(first.body.entities[0]);
  first.body.entities[0].reason_text = 'changed';
  expect(second).toEqual(expected);
});

test.each([
  ['missing input', undefined],
  ['array input', []],
  ['inherited shipment ID', Object.assign(Object.create({ shipmentId: SHIPMENT_ID }), { documentNumber: DOCUMENT_NUMBER })],
  ['inherited document number', Object.assign(Object.create({ documentNumber: DOCUMENT_NUMBER }), { shipmentId: SHIPMENT_ID })],
  ['blank shipment ID', { shipmentId: ' ', documentNumber: DOCUMENT_NUMBER }],
  ['unsafe numeric document number', { shipmentId: SHIPMENT_ID, documentNumber: Number.MAX_SAFE_INTEGER + 1 }],
])('rejects %s in the lock request builder', (_description, input) => {
  expect(() => buildFyndLockRequest(input)).toThrow(expect.objectContaining({
    code: 'FYND_LOCK_REQUEST_INVALID', retryable: false,
  }));
});

test('does not invoke accessors while validating lock builder input', () => {
  const input = { documentNumber: DOCUMENT_NUMBER };
  Object.defineProperty(input, 'shipmentId', {
    enumerable: true,
    get() { throw new Error('unsafe getter'); },
  });
  expect(() => buildFyndLockRequest(input)).toThrow(expect.objectContaining({
    code: 'FYND_LOCK_REQUEST_INVALID', retryable: false,
  }));
});

test('builds the exact fresh FDK transition template with only two deferred fields', () => {
  const input = { shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER };
  const expected = {
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
            products: [{ data: { store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]' } }],
            entities: [{
              data: {
                store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]',
                meta: {
                  einvoice_info: {
                    invoice: {
                      InvoiceNumber: '$OEIS_RESPONSE.InvoiceNumber',
                      SignedQRCode: { $deferred: 'QRCodeData' },
                    },
                  },
                  xml: {
                    content: { $deferred: 'decoded ReportingApiResponse.SignedXmlEncoded' },
                    filename: '$OEIS_RESPONSE.InvoiceNumber.xml',
                  },
                },
              },
            }],
          },
        }],
      }],
    },
  };

  const first = buildFyndTransitionTemplate(input);
  const second = buildFyndTransitionTemplate(input);
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  expect(second).not.toBe(first);
  expect(second.body.statuses).not.toBe(first.body.statuses);
  first.body.statuses[0].shipments[0].data_updates.entities[0].data.meta
    .einvoice_info.invoice.SignedQRCode.$deferred = 'changed';
  expect(second).toEqual(expected);
  const serialized = JSON.stringify(second);
  expect((serialized.match(/\"\$deferred\"/g) || [])).toHaveLength(2);
});

test.each([
  ['missing shipment ID', { documentNumber: DOCUMENT_NUMBER }],
  ['symbolic document number', { shipmentId: SHIPMENT_ID, documentNumber: Symbol('document') }],
  ['class instance input', new (class Input {
    constructor() {
      this.shipmentId = SHIPMENT_ID;
      this.documentNumber = DOCUMENT_NUMBER;
    }
  })()],
])('rejects %s in the transition template builder', (_description, input) => {
  expect(() => buildFyndTransitionTemplate(input)).toThrow(expect.objectContaining({
    code: 'FYND_TRANSITION_REQUEST_INVALID', retryable: false,
  }));
});

test('locks one shipment with the FDK lock contract and reports the locked result', async () => {
  const platform = makePlatform();
  const { client, getPlatformClient } = makeClient(platform);

  await expect(client.lockShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER }))
    .resolves.toEqual({ shipmentId: SHIPMENT_ID, locked: true, responseStatus: null });
  expect(getPlatformClient).toHaveBeenCalledTimes(1);
  expect(getPlatformClient).toHaveBeenCalledWith(COMPANY_ID);
  expect(platform.order.updateShipmentLock).toHaveBeenCalledWith({
    body: {
      entity_type: 'shipments',
      action: 'lock',
      action_type: 'complete',
      entities: [{ id: SHIPMENT_ID, reason_text: `OEIS invoice ${DOCUMENT_NUMBER}` }],
    },
  });
});

test.each([
  ['an absent optional check response', { success: true }],
  ['a matching installed check response', { success: true, check_response: [{ shipment_id: SHIPMENT_ID, is_shipment_locked: true }] }],
])('accepts %s', async (_description, lockResult) => {
  const { client } = makeClient(makePlatform({ lockResult }));
  await expect(client.lockShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER }))
    .resolves.toEqual({ shipmentId: SHIPMENT_ID, locked: true, responseStatus: null });
});

test.each([
  ['missing success', {}],
  ['a false success flag', { success: false }],
  ['an explicitly unlocked installed check response', { success: true, check_response: [{ shipment_id: SHIPMENT_ID, is_shipment_locked: false }] }],
])('rejects lock responses with %s', async (_description, lockResult) => {
  const { client } = makeClient(makePlatform({ lockResult }));
  await expect(client.lockShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER }))
    .rejects.toEqual(expect.objectContaining({ name: 'EinvoiceError', code: 'FYND_LOCK_RESPONSE_INVALID', retryable: false }));
});

test('transitions and unlocks using only the OEIS invoice for store IDs and XML filename', async () => {
  const platform = makePlatform();
  const { client, getPlatformClient } = makeClient(platform);

  await expect(client.transitionToInvoiced(transitionInput())).resolves.toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    responseStatus: null,
  });
  expect(getPlatformClient).toHaveBeenCalledTimes(1);
  expect(getPlatformClient).toHaveBeenCalledWith(COMPANY_ID);
  expect(platform.order.updateShipmentStatus).toHaveBeenCalledWith({
    body: {
      task: false,
      force_transition: false,
      unlock_before_transition: true,
      lock_after_transition: false,
      statuses: [{
        status: 'bag_invoiced',
        shipments: [{
          identifier: SHIPMENT_ID,
          products: [],
          data_updates: {
            products: [{ data: { store_invoice_id: OEIS_INVOICE_CODE } }],
            entities: [{
              data: {
                store_invoice_id: OEIS_INVOICE_CODE,
                meta: {
                  einvoice_info: {
                    invoice: { InvoiceNumber: OEIS_INVOICE_NUMBER, SignedQRCode: QR_CODE_DATA },
                  },
                  xml: { content: SIGNED_XML, filename: `${OEIS_INVOICE_NUMBER}.xml` },
                },
              },
            }],
          },
        }],
      }],
    },
  });
  const body = platform.order.updateShipmentStatus.mock.calls[0][0].body;
  expect(body).not.toHaveProperty('exclude_bags_next_state');
  expect(body.statuses[0].shipments[0].data_updates.products[0].data).not.toHaveProperty('meta');
});

test('normalizes and limits the OEIS-derived store ID to Fynd-safe 25 characters', async () => {
  const platform = makePlatform();
  const { client } = makeClient(platform);

  await client.transitionToInvoiced({
    ...transitionInput(),
    invoiceNumber: LONG_OEIS_INVOICE_NUMBER,
  });

  const shipment = platform.order.updateShipmentStatus.mock.calls[0][0]
    .body.statuses[0].shipments[0];
  expect(shipment.data_updates.products[0].data.store_invoice_id)
    .toBe(LONG_OEIS_INVOICE_CODE);
  expect(shipment.data_updates.entities[0].data.store_invoice_id)
    .toBe(LONG_OEIS_INVOICE_CODE);
  expect(shipment.data_updates.entities[0].data.meta.einvoice_info.invoice.InvoiceNumber)
    .toBe(LONG_OEIS_INVOICE_NUMBER);
  expect(shipment.data_updates.entities[0].data.meta.xml.filename)
    .toBe(`${LONG_OEIS_INVOICE_NUMBER}.xml`);
});

test('normalizes the exact live slash-and-underscore OEIS invoice for Fynd only', () => {
  expect(toFyndStoreInvoiceId('V_IN_1-117/2026/0000000001'))
    .toBe('V-IN-1-117-2026-000000000');
});

test.each([
  ['the nested installed SDK result', nestedTransitionSuccess()],
  ['the installed auto-advanced DP-assigned result', nestedTransitionSuccess({
    final_state: { shipment_id: SHIPMENT_ID, bag_invoiced: 'dp_assigned' },
  })],
  ['a flat statuses result with a string HTTP status', flatTransitionSuccess({ status: '200' })],
  ['a top-level flat shipment result', { shipments: [transitionResult()] }],
  ['an envelope success message', { ...nestedTransitionSuccess(), success: true, message: 'Transition accepted' }],
])('accepts %s only after semantic confirmation', async (_description, statusResult) => {
  const { client } = makeClient(makePlatform({ transitionResult: statusResult }));
  await expect(client.transitionToInvoiced(transitionInput())).resolves.toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    responseStatus: null,
  });
});

test('returns only safe nullable metadata from Fynd mutations without mutating SDK results', async () => {
  const lockResult = {
    success: true,
    response: { status: 202 },
    headers: { authorization: 'Bearer fynd-token' },
    customer: { name: 'Customer Name' },
    payment_info: [{ card_number: '4111111111111111' }],
    bags: [{ bag_id: 'private-bag' }],
    xml: SIGNED_XML,
    qr: SIGNED_XML_BASE64,
  };
  const statusResult = {
    ...nestedTransitionSuccess(),
    response: { status: 202 },
    headers: { authorization: 'Bearer fynd-token' },
    customer: { name: 'Customer Name' },
    payment_info: [{ card_number: '4111111111111111' }],
    bags: [{ bag_id: 'private-bag' }],
    xml: SIGNED_XML,
    qr: SIGNED_XML_BASE64,
  };
  const lockSnapshot = structuredClone(lockResult);
  const transitionSnapshot = structuredClone(statusResult);
  const { client } = makeClient(makePlatform({ lockResult, transitionResult: statusResult }));

  const locked = await client.lockShipment({
    companyId: COMPANY_ID,
    shipmentId: SHIPMENT_ID,
    documentNumber: DOCUMENT_NUMBER,
  });
  const transitioned = await client.transitionToInvoiced(transitionInput());

  expect(locked).toEqual({ shipmentId: SHIPMENT_ID, locked: true, responseStatus: null });
  expect(transitioned).toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    responseStatus: null,
  });
  expect(Object.keys(locked)).toEqual(['shipmentId', 'locked', 'responseStatus']);
  expect(Object.keys(transitioned)).toEqual(['shipmentId', 'status', 'responseStatus']);
  expect(Object.isFrozen(locked)).toBe(false);
  expect(Object.isFrozen(transitioned)).toBe(false);
  const normalized = JSON.stringify({ locked, transitioned });
  for (const sentinel of [
    'fynd-token', 'Customer Name', '4111111111111111', 'private-bag',
    SIGNED_XML, SIGNED_XML_BASE64,
  ]) {
    expect(normalized).not.toContain(sentinel);
  }
  expect(lockResult).toEqual(lockSnapshot);
  expect(statusResult).toEqual(transitionSnapshot);
  expect(Object.isFrozen(lockResult)).toBe(false);
  expect(Object.isFrozen(statusResult)).toBe(false);
});

test.each([
  ['a wrong shipment identifier', nestedTransitionSuccess({ identifier: 'other-shipment' })],
  ['a non-2xx shipment status', nestedTransitionSuccess({ status: 400 })],
  ['a shipment code', nestedTransitionSuccess({ code: 'BAD_REQUEST' })],
  ['a shipment exception', nestedTransitionSuccess({ exception: 'validation failed' })],
  ['a shipment failure message', nestedTransitionSuccess({ failure_message: 'cannot transition' })],
  ['an envelope success contradiction', { ...nestedTransitionSuccess(), success: false }],
  ['a status wrapper success contradiction', { statuses: [{ success: false, shipments: [transitionResult()] }] }],
  ['a shipment success contradiction', nestedTransitionSuccess({ success: false })],
  ['an envelope error list', { ...nestedTransitionSuccess(), errors: ['cannot transition'] }],
  ['a status wrapper failure object', { statuses: [{ failure: { reason: 'cannot transition' }, shipments: [transitionResult()] }] }],
  ['a shipment error list', nestedTransitionSuccess({ errors: ['cannot transition'] })],
  ['a shipment failure object', nestedTransitionSuccess({ failure: { reason: 'cannot transition' } })],
  ['a mismatched final-state shipment id', nestedTransitionSuccess({ final_state: { shipment_id: 'other-shipment', bag_invoiced: 'bag_invoiced' } })],
  ['an absent final bag-invoiced state', nestedTransitionSuccess({ final_state: { shipment_id: SHIPMENT_ID } })],
  ['duplicate matching shipment results', { statuses: [{ shipments: [transitionResult(), transitionResult()] }] }],
])('rejects %s even when the FDK promise resolves', async (_description, statusResult) => {
  const { client } = makeClient(makePlatform({ transitionResult: statusResult }));
  await expect(client.transitionToInvoiced(transitionInput()))
    .rejects.toEqual(expect.objectContaining({ name: 'EinvoiceError', code: 'FYND_TRANSITION_RESPONSE_INVALID', retryable: false }));
});

test('normalizes safe read-back metadata while retaining private reconciliation fields by reference', async () => {
  const shipment = consistentReadShipment();
  const shipmentSnapshot = structuredClone(shipment);
  const platform = makePlatform({ shipmentResult: { success: true, shipments: [shipment] } });
  const { client, getPlatformClient } = makeClient(platform);

  const result = await client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID });

  expect(result).toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    locked: false,
    invoiceId: DOCUMENT_NUMBER,
    meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } } },
    responseStatus: null,
  });
  expect(Object.keys(result)).toEqual([
    'shipmentId', 'status', 'locked', 'invoiceId', 'meta', 'responseStatus',
  ]);
  expect(result.meta).toBe(shipment.meta);
  const { invoiceId, meta, ...safeMetadata } = result;
  expect(invoiceId).toBe(DOCUMENT_NUMBER);
  expect(meta).toBe(shipment.meta);
  expect(safeMetadata).toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    locked: false,
    responseStatus: null,
  });
  const normalized = JSON.stringify(safeMetadata);
  for (const sentinel of [
    'Customer Name', '4111111111111111', 'bag-1', 'customer@example.test',
    SIGNED_XML_BASE64,
  ]) {
    expect(normalized).not.toContain(sentinel);
  }
  expect(shipment).toEqual(shipmentSnapshot);
  expect(Object.isFrozen(result)).toBe(false);
  expect(Object.isFrozen(shipment)).toBe(false);
  expect(Object.isFrozen(shipment.meta)).toBe(false);
  expect(getPlatformClient).toHaveBeenCalledWith(COMPANY_ID);
  expect(platform.order.getShipmentById).toHaveBeenCalledWith({ shipmentId: SHIPMENT_ID, allowInactive: true });
});

test('accepts equal redundant status, lock, and invoice representations', async () => {
  const platform = makePlatform({ shipmentResult: {
    success: true,
    shipments: [consistentReadShipment()],
  } });
  const { client } = makeClient(platform);

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID })).resolves.toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    locked: false,
    invoiceId: DOCUMENT_NUMBER,
    meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } } },
    responseStatus: null,
  });
});

test('accepts equal redundant shipment identifiers', async () => {
  const shipmentResult = {
    success: true,
    shipments: [consistentReadShipment({ id: SHIPMENT_ID, identifier: SHIPMENT_ID })],
  };
  const { client } = makeClient(makePlatform({ shipmentResult }));

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .resolves.toEqual(expect.objectContaining({ shipmentId: SHIPMENT_ID }));
});

test('uses installed field fallbacks and never substitutes array custom metadata', async () => {
  const platform = makePlatform({ shipmentResult: {
    success: true,
    shipments: [consistentReadShipment({
      shipment_status: undefined,
      status: { current_shipment_status: 'bag_invoiced' },
      lock_status: undefined,
      lock_details: { lock_status: false },
      shipment_details: undefined,
      store_invoice_id: undefined,
      invoice: { store_invoice_id: DOCUMENT_NUMBER },
      invoice_id: undefined,
      gst_details: undefined,
      meta: undefined,
    })],
  } });
  const { client } = makeClient(platform);

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID })).resolves.toEqual({
    shipmentId: SHIPMENT_ID,
    status: 'bag_invoiced',
    locked: false,
    invoiceId: DOCUMENT_NUMBER,
    meta: undefined,
    responseStatus: null,
  });
});

test('treats null optional invoice aliases from a pre-invoice Fynd read-back as absent', async () => {
  const platform = makePlatform({ shipmentResult: {
    success: true,
    shipments: [readShipment({
      status: { status: 'bag_confirmed', current_shipment_status: 'bag_confirmed' },
      shipment_status: 'bag_confirmed',
      lock_status: true,
      lock_details: undefined,
      shipment_details: { lock_status: true },
      invoice: { store_invoice_id: null },
      gst_details: { store_invoice_id: null },
      meta: undefined,
    })],
  } });
  const { client } = makeClient(platform);

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .resolves.toEqual({
      shipmentId: SHIPMENT_ID,
      status: 'bag_confirmed',
      locked: true,
      invoiceId: undefined,
      meta: undefined,
      responseStatus: null,
    });
});

test.each([
  ['shipment_status conflicts with status.status', { shipment_status: 'bag_confirmed' }],
  ['status.status conflicts with status.current_shipment_status', { status: { status: 'bag_dispatch', current_shipment_status: 'bag_invoiced' } }],
  ['lock_status conflicts with lock_details.lock_status', { lock_status: true }],
  ['lock_details.lock_status conflicts with shipment_details.lock_status', { lock_details: { lock_status: true } }],
  ['store_invoice_id conflicts with invoice.store_invoice_id', { store_invoice_id: 'OTHER-INVOICE' }],
  ['invoice.store_invoice_id conflicts with invoice_id', { invoice: { store_invoice_id: 'OTHER-INVOICE' } }],
  ['invoice_id conflicts with gst_details.store_invoice_id', { invoice_id: 'OTHER-INVOICE' }],
])('rejects a read-back when %s', async (_description, overrides) => {
  const shipmentResult = { success: true, shipments: [consistentReadShipment(overrides)] };
  const { client } = makeClient(makePlatform({ shipmentResult }));

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
});

test('ignores inherited reconciliation fields from a polluted Object.prototype', async () => {
  const shipment = { shipment_id: SHIPMENT_ID };
  const inherited = {
    shipment_status: 'bag_invoiced',
    lock_status: false,
    store_invoice_id: DOCUMENT_NUMBER,
    meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } } },
  };
  for (const [key, value] of Object.entries(inherited)) {
    Object.defineProperty(Object.prototype, key, { configurable: true, value });
  }

  try {
    const shipmentResult = { success: true, shipments: [shipment] };
    const { client } = makeClient(makePlatform({ shipmentResult }));
    await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
      .resolves.toEqual({
        shipmentId: SHIPMENT_ID,
        status: undefined,
        locked: undefined,
        invoiceId: undefined,
        meta: undefined,
        responseStatus: null,
      });
  } finally {
    for (const key of Object.keys(inherited)) delete Object.prototype[key];
  }
});

test('requires the response envelope to own its success flag', async () => {
  Object.defineProperty(Object.prototype, 'success', { configurable: true, value: true });
  try {
    const shipmentResult = { shipments: [consistentReadShipment()] };
    const { client } = makeClient(makePlatform({ shipmentResult }));
    await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
      .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
  } finally {
    delete Object.prototype.success;
  }
});

test.each([
  ['matching shipment identifier', 'shipment_id', SHIPMENT_ID],
  ['shipment collection', 'shipments', [consistentReadShipment()]],
])('does not trust an inherited %s', async (_description, key, value) => {
  Object.defineProperty(Object.prototype, key, { configurable: true, value });
  try {
    const shipmentResult = key === 'shipment_id'
      ? { success: true, shipments: [{ shipment_status: 'bag_invoiced' }] }
      : { success: true };
    const { client } = makeClient(makePlatform({ shipmentResult }));
    await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
      .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
  } finally {
    delete Object.prototype[key];
  }
});

test('normalizes a throwing supplied getter to the safe shipment response error', async () => {
  const shipment = { shipment_id: SHIPMENT_ID };
  Object.defineProperty(shipment, 'shipment_status', {
    configurable: true,
    get() { throw new Error('unsafe inherited getter'); },
  });
  const shipmentResult = { success: true, shipments: [shipment] };
  const { client } = makeClient(makePlatform({ shipmentResult }));
  try {
    await client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID });
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
    expect(error.message).not.toContain('unsafe inherited getter');
    return;
  }
  throw new Error('Expected the supplied getter to be normalized');
});

test.each([
  ['a malformed shipment sibling', { success: true, shipments: [consistentReadShipment(), null] }],
  ['a malformed items collection', { success: true, shipments: [consistentReadShipment()], items: 7 }],
  ['a malformed singular shipment container', { success: true, shipments: [consistentReadShipment()], shipment: [] }],
])('rejects a read-back containing %s', async (_description, shipmentResult) => {
  const { client } = makeClient(makePlatform({ shipmentResult }));
  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
});

test.each([
  ['a missing identifier', 'undefined', consistentReadShipment({ shipment_id: undefined })],
  ['a null identifier', 'null', consistentReadShipment({ shipment_id: null })],
  ['an object identifier', '[object Object]', consistentReadShipment({ shipment_id: {} })],
  ['a fractional identifier', '1.5', consistentReadShipment({ shipment_id: 1.5 })],
  ['an unsafe integer identifier', String(Number.MAX_SAFE_INTEGER + 1), consistentReadShipment({ shipment_id: Number.MAX_SAFE_INTEGER + 1 })],
  ['conflicting identifier aliases', SHIPMENT_ID, consistentReadShipment({ id: 'other-shipment' })],
])('rejects a read-back containing %s', async (_description, requestedShipmentId, shipment) => {
  const shipmentResult = { success: true, shipments: [shipment] };
  const { client } = makeClient(makePlatform({ shipmentResult }));
  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: requestedShipmentId }))
    .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
});

test.each([
  ['shipment_status has the wrong type', { shipment_status: 200 }],
  ['shipment_status is empty', { shipment_status: '  ' }],
  ['status is not a plain object', { status: [] }],
  ['status.status has the wrong type', { status: { status: false } }],
  ['status.current_shipment_status is empty', { status: { current_shipment_status: '' } }],
  ['lock_status has the wrong type', { lock_status: 'false' }],
  ['lock_details is not a plain object', { lock_details: [] }],
  ['lock_details.lock_status has the wrong type', { lock_details: { lock_status: 0 } }],
  ['shipment_details is not a plain object', { shipment_details: null }],
  ['shipment_details.lock_status has the wrong type', { shipment_details: { lock_status: 'false' } }],
  ['store_invoice_id has the wrong type', { store_invoice_id: {} }],
  ['store_invoice_id is empty', { store_invoice_id: '  ' }],
  ['invoice is not a plain object', { invoice: [] }],
  ['invoice.store_invoice_id has the wrong type', { invoice: { store_invoice_id: false } }],
  ['invoice_id is empty', { invoice_id: '' }],
  ['gst_details is not a plain object', { gst_details: null }],
  ['gst_details.store_invoice_id has the wrong type', { gst_details: { store_invoice_id: 1.5 } }],
  ['meta is null', { meta: null }],
  ['meta is an array', { meta: [] }],
  ['meta has a custom prototype', { meta: Object.assign(Object.create({ inherited: true }), { einvoice_info: {} }) }],
])('rejects a read-back when %s', async (_description, overrides) => {
  const shipmentResult = { success: true, shipments: [consistentReadShipment(overrides)] };
  const { client } = makeClient(makePlatform({ shipmentResult }));

  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
});

test.each([
  ['missing success', { shipments: [readShipment()] }],
  ['no matching shipment', { success: true, shipments: [consistentReadShipment({ shipment_id: 'other-shipment' })] }],
  ['multiple matching shipments', { success: true, shipments: [consistentReadShipment(), consistentReadShipment()] }],
  ['a malformed shipment entry', { success: true, shipments: [null] }],
])('rejects an untrustworthy read-back with %s', async (_description, shipmentResult) => {
  const { client } = makeClient(makePlatform({ shipmentResult }));
  await expect(client.getShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID }))
    .rejects.toEqual(expect.objectContaining({ code: 'FYND_SHIPMENT_RESPONSE_INVALID', retryable: false }));
});

test.each([
  ['a timeout', { code: 'ETIMEDOUT', message: `${SIGNED_XML} customer@example.test` }, 'FYND_TIMEOUT', true],
  ['a network failure', { code: 'EAI_AGAIN', message: `${SIGNED_XML} customer@example.test` }, 'FYND_NETWORK', true],
  ['a rate limit', { response: { status: 429, data: { customer: 'Customer Name' } } }, 'FYND_HTTP_429', true],
  ['a server error', { response: { status: 503, data: { customer: 'Customer Name' } } }, 'FYND_HTTP_5XX', true],
  ['a string server status', { response: { status: '503', data: { customer: 'Customer Name' } } }, 'FYND_HTTP_5XX', true],
  ['a client error', { response: { status: 400, data: { customer: 'Customer Name' } } }, 'FYND_HTTP_4XX', false],
  ['an FDK EinvoiceError', new EinvoiceError('UNSAFE', SIGNED_XML, { cause: { customer: 'Customer Name' } }), 'FYND_REQUEST_FAILED', false],
  ['an FDK server error code', { name: 'FDKServerResponseError', status: 'Internal Server Error', code: 503, message: `${SIGNED_XML} Customer Name` }, 'FYND_HTTP_5XX', true],
  ['an FDK rate-limit string code', { name: 'FDKServerResponseError', status: 'Too Many Requests', code: '429', message: `${SIGNED_XML} Customer Name` }, 'FYND_HTTP_429', true],
  ['a response status before a conflicting FDK code', { name: 'FDKServerResponseError', response: { status: 400 }, status: 'Internal Server Error', code: 503 }, 'FYND_HTTP_4XX', false],
])('sanitizes %s without attaching FDK errors or sensitive request data', async (_description, sdkError, code, retryable) => {
  const platform = makePlatform();
  platform.order.updateShipmentLock.mockRejectedValue(sdkError);
  const { client } = makeClient(platform);

  try {
    await client.lockShipment({ companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER });
  } catch (error) {
    expect(error).toBeInstanceOf(EinvoiceError);
    expect(error).toEqual(expect.objectContaining({ code, retryable }));
    expect(error.message).not.toContain(SIGNED_XML);
    expect(error.message).not.toContain('Customer Name');
    expect(error.message).not.toContain('customer@example.test');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('request');
    expect(JSON.stringify(error)).not.toContain(SIGNED_XML);
    return;
  }
  throw new Error('Expected the FDK error to be normalized');
});

test('rejects missing factory options with a safe configuration error', () => {
  expect(() => createFyndShipmentClient()).toThrow(expect.objectContaining({
    name: 'EinvoiceError', code: 'FYND_CLIENT_INVALID', retryable: false,
  }));
});

test.each([
  ['null lock input', 'lockShipment', null],
  ['a non-finite lock company id', 'lockShipment', { companyId: NaN, shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER }],
  ['a symbolic lock company id', 'lockShipment', { companyId: Symbol('company'), shipmentId: SHIPMENT_ID, documentNumber: DOCUMENT_NUMBER }],
  ['an object lock shipment id', 'lockShipment', { companyId: COMPANY_ID, shipmentId: {}, documentNumber: DOCUMENT_NUMBER }],
  ['a symbolic lock document number', 'lockShipment', { companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, documentNumber: Symbol('document') }],
  ['null transition input', 'transitionToInvoiced', null],
  ['an object transition company id', 'transitionToInvoiced', { ...transitionInput(), companyId: {} }],
  ['a symbolic QR value', 'transitionToInvoiced', { ...transitionInput(), qrCodeData: Symbol('qr') }],
  ['an object signed XML value', 'transitionToInvoiced', { ...transitionInput(), signedXml: {} }],
  ['null read-back input', 'getShipment', null],
  ['a symbolic read-back shipment id', 'getShipment', { companyId: COMPANY_ID, shipmentId: Symbol('shipment') }],
])('rejects %s before invoking FDK', async (_description, operation, input) => {
  const platform = makePlatform();
  const { client, getPlatformClient } = makeClient(platform);

  await expect(client[operation](input)).rejects.toEqual(expect.objectContaining({
    name: 'EinvoiceError', retryable: false,
  }));
  expect(getPlatformClient).not.toHaveBeenCalled();
  expect(platform.order.updateShipmentLock).not.toHaveBeenCalled();
  expect(platform.order.updateShipmentStatus).not.toHaveBeenCalled();
  expect(platform.order.getShipmentById).not.toHaveBeenCalled();
});
