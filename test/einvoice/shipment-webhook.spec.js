'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const { createEventKey } = require('../../src/einvoice/audit/audit-contract');
const { JOB_STATES } = require('../../src/einvoice/repositories/invoice-repository');
const { createShipmentWebhookHandler } = require('../../src/einvoice/webhooks/shipment-webhook');
const { makeLiveNestedShipmentWebhook } = require('../fixtures/einvoice/shipment');

const EVENT_NAME = 'application/shipment/update/v1';
const RECEIVED_AT = new Date('2026-08-10T04:30:00.000Z');

function validBody(overrides = {}) {
  const shipment = {
    shipment_id: 'shipment-1',
    shipment_status: {
      status: 'bag_confirmed',
      status_created_at: '2026-08-10T03:45:00.000Z',
      created_ts: '2026-08-10T03:45:00.000Z',
    },
    fulfilling_store: { code: 'store-1' },
    currency: 'SAR',
    payment_info: [{ mode: 'CARD' }],
    amount_paid: '115.00',
    bags: [{
      bag_id: 'bag-1',
      seller_identifier: 'product-1',
      quantity: 1,
      financial_breakup: {
        price_effective: '115.00',
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '15.00',
        value_of_good: '100.00',
        gst_tax_percentage: '15.00',
        gst_fee: '15.00',
        amount_paid: '115.00',
      },
    }],
    ...overrides.shipment,
  };
  return {
    event: { id: 'event-1' },
    company_id: 'company-1',
    application_id: 'application-1',
    payload: { shipment },
    ...overrides.body,
  };
}

function createSetup(overrides = {}) {
  const repository = {
    appendAuditEvents: jest.fn(async () => undefined),
    acceptWebhook: jest.fn(async () => ({ created: true, jobId: 17 })),
    ...overrides.repository,
  };
  const logger = { error: jest.fn(), ...overrides.logger };
  const now = jest.fn(() => RECEIVED_AT);
  return {
    repository,
    logger,
    now,
    handler: createShipmentWebhookHandler({
      enabled: true,
      dryRunEnabled: false,
      repository,
      logger,
      now,
      ...overrides.options,
    }),
  };
}

describe('shipment webhook handler', () => {
  test('exports durable dry-run and held submission job states', () => {
    expect(JOB_STATES).toEqual(expect.objectContaining({
      DRY_RUN_RECEIVED: 'DRY_RUN_RECEIVED',
      DRY_RUN_LOCK_PENDING: 'DRY_RUN_LOCK_PENDING',
      DRY_RUN_RETRY_WAIT: 'DRY_RUN_RETRY_WAIT',
      SUBMISSION_HELD: 'SUBMISSION_HELD',
    }));
  });

  test('commits receipt and validation start before rejecting a semantic accessor without executing it', async () => {
    const trace = [];
    const counter = { calls: 0 };
    const repository = {
      appendAuditEvents: jest.fn(async events => {
        trace.push(`append:${events.map(event => event.action).join(',')}:start`);
        await Promise.resolve();
        trace.push(`append:${events.map(event => event.action).join(',')}:done`);
      }),
      acceptWebhook: jest.fn(async () => ({ created: true, jobId: 17 })),
    };
    const setup = createSetup({ repository });
    const body = validBody();
    const currency = body.payload.shipment.currency;
    Object.defineProperty(body.payload.shipment, 'currency', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return currency;
      },
    });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'CURRENCY_UNSUPPORTED' }));

    expect(trace).toEqual([
      'append:WEBHOOK_RECEIVED:start',
      'append:WEBHOOK_RECEIVED:done',
      'append:VALIDATION_STARTED:start',
      'append:VALIDATION_STARTED:done',
      'append:VALIDATION_FAILED,WEBHOOK_REJECTED:start',
      'append:VALIDATION_FAILED,WEBHOOK_REJECTED:done',
    ]);
    expect(counter.calls).toBe(0);
    expect(repository.acceptWebhook).not.toHaveBeenCalled();
  });

  test.each([
    ['receipt failure', new EinvoiceError('REPOSITORY_UNAVAILABLE', 'private database detail')],
    ['receipt unknown commit', new EinvoiceError('REPOSITORY_TRANSACTION_UNKNOWN', 'private commit detail')],
  ])('stops before all semantic reads on %s', async (_description, failure) => {
    const counter = { calls: 0 };
    const body = validBody();
    Object.defineProperty(body.payload.shipment, 'currency', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('must-not-read'); },
    });
    const setup = createSetup({
      repository: {
        appendAuditEvents: jest.fn(async () => { throw failure; }),
        acceptWebhook: jest.fn(),
      },
    });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1')).rejects.toBe(failure);
    expect(counter.calls).toBe(0);
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', failure.code,
    );
  });

  test('writes no shipment audit and executes no traps when trusted identity cannot be extracted', async () => {
    const counter = { calls: 0 };
    const hostile = new Proxy({}, {
      getPrototypeOf() { counter.calls += 1; throw new Error('identity-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('identity-secret'); },
      get() { counter.calls += 1; throw new Error('identity-secret'); },
    });
    const setup = createSetup();

    await expect(setup.handler(EVENT_NAME, hostile, 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'WEBHOOK_PAYLOAD_INVALID' }));
    expect(counter.calls).toBe(0);
    expect(setup.repository.appendAuditEvents).not.toHaveBeenCalled();
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'WEBHOOK_PAYLOAD_INVALID',
    );
  });

  test('audits an ignored shipment without creating a webhook or job row', async () => {
    const setup = createSetup();
    const body = validBody({ shipment: { shipment_status: { status: 'bag_packed' } } });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, ignored: 'status' });

    expect(setup.repository.appendAuditEvents.mock.calls.map(([events]) => events.map(event => event.action)))
      .toEqual([['WEBHOOK_RECEIVED'], ['VALIDATION_STARTED'], ['WEBHOOK_IGNORED']]);
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
  });

  test('audits semantic rejection as one ordered failure bundle and creates no job', async () => {
    const setup = createSetup();
    const body = validBody({ shipment: { currency: 'USD' } });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'CURRENCY_UNSUPPORTED' }));

    expect(setup.repository.appendAuditEvents.mock.calls.map(([events]) => events.map(event => event.action)))
      .toEqual([
        ['WEBHOOK_RECEIVED'],
        ['VALIDATION_STARTED'],
        ['VALIDATION_FAILED', 'WEBHOOK_REJECTED'],
      ]);
    const rejected = setup.repository.appendAuditEvents.mock.calls[2][0];
    expect(rejected.map(event => event.safeCode)).toEqual(['CURRENCY_UNSUPPORTED', 'CURRENCY_UNSUPPORTED']);
    expect(rejected[0].startedAt).toBe(setup.repository.appendAuditEvents.mock.calls[1][0][0].startedAt);
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
  });

  test('passes canonical validation evidence into atomic acceptance and keeps platform replay keys stable', async () => {
    const dates = [
      new Date('2026-08-10T04:30:00.000Z'),
      new Date('2026-08-10T04:30:00.010Z'),
      new Date('2026-08-10T04:30:00.025Z'),
      new Date('2026-08-10T04:31:00.000Z'),
      new Date('2026-08-10T04:31:00.010Z'),
      new Date('2026-08-10T04:31:00.025Z'),
    ];
    const repository = {
      appendAuditEvents: jest.fn(async () => undefined),
      acceptWebhook: jest.fn()
        .mockResolvedValueOnce({ created: true, jobId: 17 })
        .mockResolvedValueOnce({ created: false, jobId: 17 }),
    };
    const setup = createSetup({
      repository,
      options: { now: jest.fn(() => dates.shift()) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });
    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: false, jobId: 17 });

    const firstReceipt = repository.appendAuditEvents.mock.calls[0][0][0];
    const secondReceipt = repository.appendAuditEvents.mock.calls[2][0][0];
    expect(firstReceipt.eventKey).toBe(createEventKey({
      kind: 'WEBHOOK_RECEIPT', companyId: 'company-1', eventId: 'event-1',
    }));
    expect(secondReceipt.eventKey).toBe(firstReceipt.eventKey);
    const validation = repository.acceptWebhook.mock.calls[0][3];
    expect(validation).toHaveLength(1);
    expect(validation[0]).toEqual(expect.objectContaining({
      operationKey: null,
      companyId: 'company-1',
      applicationId: 'application-1',
      shipmentId: 'shipment-1',
      jobId: null,
      documentNumber: null,
      stage: 'VALIDATION',
      action: 'VALIDATION_PASSED',
      outcome: 'SUCCESS',
      attemptNumber: 0,
      queueDelayMs: null,
      retryDelayMs: null,
      safeCode: null,
      requestSummary: null,
      responseSummary: null,
      artifactJobId: null,
    }));
  });

  test('accepts the sanitized live nested Fynd shipment as a canonical snapshot and creates its job', async () => {
    const setup = createSetup();

    await expect(setup.handler(
      EVENT_NAME,
      makeLiveNestedShipmentWebhook(),
      12655,
      'app-1',
    )).resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });

    expect(setup.repository.acceptWebhook).toHaveBeenCalledTimes(1);
    const [eventRecord, shipment, dryRunEnabled, validation] =
      setup.repository.acceptWebhook.mock.calls[0];
    expect(eventRecord).toEqual({
      eventId: 'evt-live-safe-1',
      companyId: '12655',
      applicationId: 'app-1',
      shipmentId: '17861361389811907490',
      eventType: EVENT_NAME,
      status: 'bag_confirmed',
      receivedAt: RECEIVED_AT,
    });
    expect(shipment).toEqual({
      shipmentId: '17861361389811907490',
      confirmedAt: '2026-08-18T06:30:00.000Z',
      branchCode: 'BRANCH-01',
      currency: 'SAR',
      paymentMode: 'CARD',
      amountPaid: '38.38',
      policyVersion: '2026-08-17',
      taxEligibility: {
        governmentBorneVatEligible: false,
        reasonCode: null,
        evidenceReference: 'evt-live-safe-1',
        verifiedAt: '2026-08-18T06:30:00.000Z',
        buyerName: null,
        buyerNationalId: null,
      },
      bags: [{
        bagId: 'bag-live-safe-1',
        lineNumber: 1,
        productCode: 'SKU-LIVE-01',
        quantity: 1,
        financialBreakup: {
          price_effective: '33.37',
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
          value_of_good: '33.37',
          gst_tax_percentage: '15.00',
          gst_fee: '5.01',
          amount_paid: '38.38',
        },
        prices: {
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
        },
      }],
    });
    expect(dryRunEnabled).toBe(false);
    expect(validation.map(event => event.action)).toEqual(['VALIDATION_PASSED']);
    expect(setup.repository.appendAuditEvents.mock.calls
      .flatMap(([events]) => events.map(event => event.action)))
      .toEqual(['WEBHOOK_RECEIVED', 'VALIDATION_STARTED']);
    expect(setup.logger.error).not.toHaveBeenCalled();
  });

  test('rejects a Proxy repository acknowledgement without invoking its traps', async () => {
    const counter = { calls: 0 };
    const acknowledgement = new Proxy({ created: true, jobId: 17 }, {
      getPrototypeOf() { counter.calls += 1; throw new Error('ack-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('ack-secret'); },
      get(_target, key) {
        if (key === 'then') return undefined;
        counter.calls += 1;
        throw new Error('ack-secret');
      },
    });
    const setup = createSetup({
      repository: { acceptWebhook: jest.fn(async () => acknowledgement) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'WEBHOOK_STORAGE_RESULT_INVALID' }));
    expect(counter.calls).toBe(0);
  });

  test('disabled acknowledges before dependency, event, or body validation', async () => {
    const handler = createShipmentWebhookHandler({ enabled: false });

    await expect(handler(undefined, null, undefined, undefined)).resolves.toEqual({
      acknowledged: true, ignored: 'disabled',
    });
  });

  test('acknowledges an unrelated shipment status after persisting its audit trail', async () => {
    const setup = createSetup();
    const body = validBody({ shipment: { shipment_status: { status: 'bag_packed' } } });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, ignored: 'status' });

    expect(setup.now).toHaveBeenCalledTimes(3);
    expect(setup.repository.appendAuditEvents).toHaveBeenCalledTimes(3);
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
  });

  test('normalizes first, persists disabled dry-run intent, and acknowledges durable creation', async () => {
    const setup = createSetup();
    const body = validBody();

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });

    expect(setup.repository.acceptWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'bag_confirmed', receivedAt: RECEIVED_AT }),
      expect.objectContaining({
        shipmentId: 'shipment-1', branchCode: 'store-1', amountPaid: '115.00',
        policyVersion: '2026-08-17',
        taxEligibility: {
          governmentBorneVatEligible: null,
          reasonCode: null,
          evidenceReference: 'event-1',
          verifiedAt: '2026-08-10T03:45:00.000Z',
          buyerName: null,
          buyerNationalId: null,
        },
      }),
      false,
      [expect.objectContaining({ action: 'VALIDATION_PASSED', outcome: 'SUCCESS' })],
    );
    expect(setup.now).toHaveBeenCalledTimes(3);
  });

  test('persists status and verification time from the same nested bag-confirmed object without reading flat status', async () => {
    const setup = createSetup();
    const body = validBody();
    const counter = { calls: 0 };
    Object.defineProperty(body.payload.shipment, 'status', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return 'bag_packed';
      },
    });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });

    expect(setup.repository.acceptWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'bag_confirmed' }),
      expect.objectContaining({
        confirmedAt: '2026-08-10T03:45:00.000Z',
        taxEligibility: expect.objectContaining({ verifiedAt: '2026-08-10T03:45:00.000Z' }),
      }),
      false,
      [expect.objectContaining({ action: 'VALIDATION_PASSED', outcome: 'SUCCESS' })],
    );
    expect(counter.calls).toBe(0);
  });

  test('normalizes first and persists enabled dry-run intent', async () => {
    const setup = createSetup({ options: { dryRunEnabled: true } });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });

    expect(setup.repository.acceptWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'bag_confirmed' }),
      expect.objectContaining({ shipmentId: 'shipment-1' }),
      true,
      [expect.objectContaining({ action: 'VALIDATION_PASSED', outcome: 'SUCCESS' })],
    );
  });

  test('acknowledges an idempotent duplicate with the existing job', async () => {
    const setup = createSetup({
      repository: { acceptWebhook: jest.fn(async () => ({ created: false, jobId: 17 })) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: false, jobId: 17 });
  });

  test('persists wrong-type private eligibility as a safe candidate without logging or rejecting', async () => {
    const setup = createSetup();
    const body = validBody({ shipment: {
      order: { meta: { custom_cart_meta: { custom_conditions: {
        taxation_nationality: 'private-invalid-value',
        recipient_name: 'Synthetic Private Name',
        national_id: 'private-invalid-id',
      } } } },
    } });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .resolves.toEqual({ acknowledged: true, created: true, jobId: 17 });
    const persisted = setup.repository.acceptWebhook.mock.calls[0][1];
    expect(persisted.taxEligibility).toEqual(expect.objectContaining({
      governmentBorneVatEligible: null, buyerName: null, buyerNationalId: null,
    }));
    expect(JSON.stringify(persisted)).not.toContain('Synthetic Private Name');
    expect(JSON.stringify(persisted)).not.toContain('private-invalid-id');
    expect(setup.logger.error).not.toHaveBeenCalled();
  });

  test('rejects validation failure and logs only fixed text plus a safe code', async () => {
    const setup = createSetup();
    const body = validBody({ body: { event: { id: 'private invalid value!' } } });

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'WEBHOOK_EVENT_ID_INVALID' }));

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'WEBHOOK_EVENT_ID_INVALID',
    );
    const logged = JSON.stringify(setup.logger.error.mock.calls);
    expect(logged).not.toContain('private invalid value');
    expect(logged).not.toContain('malformed');
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
  });

  test.each([
    ['missing event container', 'WEBHOOK_EVENT_ID_REQUIRED', (body) => { delete body.event; }],
    ['missing event id', 'WEBHOOK_EVENT_ID_REQUIRED', (body) => { delete body.event.id; }],
    ['null event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => { body.event = null; }],
    ['inherited event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      delete body.event;
      Object.setPrototypeOf(body, { event: { id: 'inherited-event-secret' } });
    }],
    ['accessor event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      Object.defineProperty(body, 'event', {
        enumerable: true,
        get() { throw new Error('accessor-event-secret'); },
      });
    }],
    ['inherited event id', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      body.event = Object.create({ id: 'inherited-id-secret' });
    }],
    ['accessor event id', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      Object.defineProperty(body.event, 'id', {
        enumerable: true,
        get() { throw new Error('accessor-id-secret'); },
      });
    }],
    ['proxied event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      body.event = new Proxy({ id: 'proxied-id-secret' }, {});
    }],
    ['array event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      body.event = Object.assign([], { id: 'array-id-secret' });
    }],
    ['class event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
      class EventContainer {
        constructor() { this.id = 'class-id-secret'; }
      }
      body.event = new EventContainer();
    }],
  ])('rejects hostile %s before persistence with only a safe log code', async (_case, code, change) => {
    const setup = createSetup();
    const body = validBody();
    change(body);

    await expect(setup.handler(EVENT_NAME, body, 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code }));
    expect(setup.logger.error).toHaveBeenCalledWith('Shipment webhook processing failed', code);
    expect(JSON.stringify(setup.logger.error.mock.calls)).not.toMatch(/(?:inherited|accessor|proxied|array|class)-(?:event|id)-secret/);
    expect(setup.repository.acceptWebhook).not.toHaveBeenCalled();
    expect(setup.now).not.toHaveBeenCalled();
  });

  test('rejects storage failure without logging the body, identifiers, raw error, or message', async () => {
    const raw = new EinvoiceError('REPOSITORY_BUSY', 'database shipment-1 secret');
    raw.body = validBody();
    const setup = createSetup({
      repository: { acceptWebhook: jest.fn(async () => { throw raw; }) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toBe(raw);

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'REPOSITORY_BUSY',
    );
    const logged = JSON.stringify(setup.logger.error.mock.calls);
    expect(logged).not.toContain('shipment-1');
    expect(logged).not.toContain('database');
    expect(logged).not.toContain('event-1');
  });

  test('uses a fixed fallback log code for unknown failures', async () => {
    const setup = createSetup({
      repository: { acceptWebhook: jest.fn(async () => { throw new Error('raw secret'); }) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toThrow('raw secret');
    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'WEBHOOK_PROCESSING_FAILED',
    );
  });

  test('does not trust an arbitrary uppercase EinvoiceError code for logging', async () => {
    const setup = createSetup({
      repository: {
        acceptWebhook: jest.fn(async () => { throw new EinvoiceError('SECRET_INTERNAL', 'raw'); }),
      },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'SECRET_INTERNAL' }));
    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'WEBHOOK_PROCESSING_FAILED',
    );
  });

  test('rejects malformed repository acknowledgement rather than falsely acknowledging', async () => {
    const setup = createSetup({ repository: { acceptWebhook: jest.fn(async () => ({ ok: true })) } });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'WEBHOOK_STORAGE_RESULT_INVALID' }));
  });

  test.each([
    ['inherited fields', () => Object.create({ created: true, jobId: 17 })],
    ['non-plain prototype', () => Object.assign(Object.create({ marker: true }), { created: true, jobId: 17 })],
    ['throwing field', () => {
      const value = { jobId: 17 };
      Object.defineProperty(value, 'created', {
        configurable: true,
        enumerable: true,
        get() { throw new Error('raw acknowledgement secret'); },
      });
      return value;
    }],
  ])('rejects unsafe repository acknowledgement %s with a safe error', async (_case, createResult) => {
    const setup = createSetup({
      repository: { acceptWebhook: jest.fn(async () => createResult()) },
    });

    await expect(setup.handler(EVENT_NAME, validBody(), 'company-1', 'application-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'WEBHOOK_STORAGE_RESULT_INVALID' }));

    expect(setup.logger.error).toHaveBeenCalledWith(
      'Shipment webhook processing failed', 'WEBHOOK_STORAGE_RESULT_INVALID',
    );
    expect(JSON.stringify(setup.logger.error.mock.calls)).not.toContain('acknowledgement secret');
  });
});

describe('shipment webhook dependency validation', () => {
  test.each([
    ['Proxy options', () => new Proxy({ enabled: false }, {
      get() { throw new Error('options-secret'); },
      getPrototypeOf() { throw new Error('options-secret'); },
      getOwnPropertyDescriptor() { throw new Error('options-secret'); },
    })],
    ['inherited enabled', () => Object.create({ enabled: false })],
    ['accessor enabled', () => Object.defineProperty({}, 'enabled', {
      enumerable: true,
      get() { throw new Error('enabled-secret'); },
    })],
  ])('rejects %s without invoking user code', (_description, createOptions) => {
    expect(() => createShipmentWebhookHandler(createOptions()))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
  });

  test.each([
    ['Proxy repository', 'repository'],
    ['Proxy logger', 'logger'],
  ])('rejects a %s without invoking its traps', (_description, field) => {
    const counter = { calls: 0 };
    const hostile = new Proxy({}, {
      get() { counter.calls += 1; throw new Error('dependency-secret'); },
      getPrototypeOf() { counter.calls += 1; throw new Error('dependency-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('dependency-secret'); },
    });
    const options = {
      enabled: true,
      dryRunEnabled: false,
      repository: {
        acceptWebhook() {},
        appendAuditEvents() {},
      },
      logger: { error() {} },
      now: () => RECEIVED_AT,
      [field]: hostile,
    };

    expect(() => createShipmentWebhookHandler(options))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
    expect(counter.calls).toBe(0);
  });

  test.each([
    ['repository method accessor', 'repository', 'acceptWebhook'],
    ['logger method accessor', 'logger', 'error'],
  ])('rejects a %s without invoking it', (_description, dependency, method) => {
    const counter = { calls: 0 };
    const target = dependency === 'repository'
      ? { appendAuditEvents() {} }
      : {};
    Object.defineProperty(target, method, {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('method-secret'); },
    });
    const options = {
      enabled: true,
      dryRunEnabled: false,
      repository: {
        acceptWebhook() {},
        appendAuditEvents() {},
      },
      logger: { error() {} },
      now: () => RECEIVED_AT,
      [dependency]: target,
    };

    expect(() => createShipmentWebhookHandler(options))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
    expect(counter.calls).toBe(0);
  });

  test('rejects an inherited now function without invoking it', () => {
    const counter = { calls: 0 };
    const options = Object.create({ now() { counter.calls += 1; return RECEIVED_AT; } });
    Object.assign(options, {
      enabled: true,
      dryRunEnabled: false,
      repository: { acceptWebhook() {}, appendAuditEvents() {} },
      logger: { error() {} },
    });

    expect(() => createShipmentWebhookHandler(options))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
    expect(counter.calls).toBe(0);
  });

  test.each([
    {},
    { enabled: 'true' },
    { enabled: true, dryRunEnabled: undefined, repository: { acceptWebhook() {} }, logger: { error() {} }, now: () => RECEIVED_AT },
    { enabled: true, dryRunEnabled: 'true', repository: { acceptWebhook() {} }, logger: { error() {} }, now: () => RECEIVED_AT },
    { enabled: true, repository: {}, logger: { error() {} }, now: () => RECEIVED_AT },
    { enabled: true, repository: { acceptWebhook() {} }, logger: {}, now: () => RECEIVED_AT },
    { enabled: true, repository: { acceptWebhook() {} }, logger: { error() {} }, now: null },
  ])('rejects unsafe enabled configuration %#', options => {
    expect(() => createShipmentWebhookHandler(options))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
  });

  test('converts a throwing enabled getter to a safe configuration error', () => {
    const options = {};
    Object.defineProperty(options, 'enabled', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('raw webhook configuration secret'); },
    });

    expect(() => createShipmentWebhookHandler(options))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_CONFIG_INVALID' }));
  });
});
