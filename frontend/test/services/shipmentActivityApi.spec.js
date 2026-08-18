import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import {
  getShipmentTimeline,
  listPreJobFailures,
  listShipmentActivity,
} from '../../services/shipmentActivityApi';

const RECENT_URL = '/api/einvoice/shipment-activity';
const PRE_JOB_FAILURES_URL = `${RECENT_URL}/pre-job-failures`;
const SHIPMENT_ID = 'shipment:17861361389811907489';
const HEAD_CURSOR = 'aGVhZF9jdXJzb3I';
const TIMELINE_CURSOR = 'dGltZWxpbmVfY3Vyc29y';
const DOCUMENT_NUMBER = 'VR-17861361389811907489-1';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const ACTION_MATRIX = Object.freeze({
  WEBHOOK_RECEIVED: ['WEBHOOK', ['SUCCESS']],
  WEBHOOK_ACCEPTED: ['WEBHOOK', ['SUCCESS']],
  WEBHOOK_DUPLICATE: ['WEBHOOK', ['SUCCESS']],
  WEBHOOK_IGNORED: ['WEBHOOK', ['SUCCESS']],
  WEBHOOK_REJECTED: ['WEBHOOK', ['FAILURE']],
  JOB_CLAIMED: ['JOB', ['SUCCESS']],
  VALIDATION_STARTED: ['VALIDATION', ['STARTED']],
  VALIDATION_PASSED: ['VALIDATION', ['SUCCESS']],
  VALIDATION_FAILED: ['VALIDATION', ['FAILURE']],
  PAYLOAD_PREPARED: ['PAYLOAD', ['SUCCESS']],
  FYND_LOCK_REQUESTED: ['FYND_LOCK', ['STARTED']],
  FYND_LOCK_CONFIRMED: ['FYND_LOCK', ['SUCCESS']],
  FYND_LOCK_FAILED: ['FYND_LOCK', ['FAILURE', 'TIMEOUT', 'INDETERMINATE']],
  FYND_LOCK_READBACK: ['FYND_LOCK', ['STARTED', 'SUCCESS', 'FAILURE', 'TIMEOUT', 'INDETERMINATE']],
  OEIS_SUBMISSION_HELD: ['OEIS_SUBMISSION', ['HELD']],
  OEIS_SUBMISSION_REQUESTED: ['OEIS_SUBMISSION', ['STARTED']],
  OEIS_RESPONSE_RECEIVED: ['OEIS_SUBMISSION', ['SUCCESS']],
  OEIS_SUBMISSION_FAILED: ['OEIS_SUBMISSION', ['FAILURE', 'TIMEOUT', 'INDETERMINATE']],
  OEIS_ARTIFACT_STORED: ['OEIS_ARTIFACT', ['SUCCESS']],
  OUTBOX_CLAIMED: ['OUTBOX', ['SUCCESS']],
  FYND_TRANSITION_REQUESTED: ['FYND_TRANSITION', ['STARTED']],
  FYND_TRANSITION_CONFIRMED: ['FYND_TRANSITION', ['SUCCESS']],
  FYND_TRANSITION_FAILED: ['FYND_TRANSITION', ['FAILURE', 'TIMEOUT', 'INDETERMINATE']],
  FYND_TRANSITION_READBACK: ['FYND_TRANSITION', ['STARTED', 'SUCCESS', 'FAILURE', 'TIMEOUT', 'INDETERMINATE']],
  RETRY_SCHEDULED: ['RETRY', ['RETRY_SCHEDULED']],
  LEASE_RECOVERED: ['LEASE', ['SUCCESS']],
  JOB_DATA_FAILED: ['JOB', ['FAILURE']],
  JOB_INDETERMINATE: ['JOB', ['INDETERMINATE']],
  JOB_COMPLETED: ['JOB', ['SUCCESS']],
  LEGACY_STATE_IMPORTED: ['MIGRATION', ['HELD', 'FAILURE', 'INDETERMINATE', 'SUCCESS']],
});

const ACTION_CASES = Object.freeze(Object.entries(ACTION_MATRIX).flatMap(
  ([action, [stage, outcomes]]) => outcomes.map(outcome => [stage, action, outcome]),
));

function recentItem(overrides = {}) {
  return {
    shipmentId: SHIPMENT_ID,
    jobId: 42,
    documentNumber: DOCUMENT_NUMBER,
    lastStage: 'WEBHOOK',
    lastAction: 'WEBHOOK_RECEIVED',
    lastOutcome: 'SUCCESS',
    lastSafeCode: null,
    firstOccurredAt: '2026-08-17T09:00:00.000Z',
    lastOccurredAt: '2026-08-17T10:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function preJobFailureItem(overrides = {}) {
  return recentItem({
    shipmentId: 'shipment:currency-unsupported',
    jobId: null,
    documentNumber: null,
    lastStage: 'WEBHOOK',
    lastAction: 'WEBHOOK_REJECTED',
    lastOutcome: 'FAILURE',
    lastSafeCode: 'CURRENCY_UNSUPPORTED',
    firstOccurredAt: '2026-08-17T08:00:00.000Z',
    lastOccurredAt: '2026-08-17T08:00:01.000Z',
    version: 1,
    ...overrides,
  });
}

function fyndRequest(operation = 'LOCK') {
  return {
    kind: 'FYND_REQUEST',
    operation,
    shipmentId: SHIPMENT_ID,
    documentNumber: DOCUMENT_NUMBER,
    requestedLock: operation === 'LOCK' ? true : null,
    requestedStatus: operation === 'TRANSITION' ? 'bag_invoiced' : null,
  };
}

function fyndResponse(operation = 'LOCK', latencyMs = 25) {
  return {
    kind: 'FYND_RESPONSE',
    operation,
    shipmentId: SHIPMENT_ID,
    documentNumber: DOCUMENT_NUMBER,
    responseStatus: null,
    locked: operation.includes('LOCK') ? true : false,
    shipmentState: operation.includes('TRANSITION') ? 'bag_invoiced' : 'bag_confirmed',
    finalStateClassification: operation.includes('TRANSITION') ? 'INVOICED' : 'LOCKED',
    retryable: false,
    latencyMs,
  };
}

function oeisRequest() {
  return {
    kind: 'OEIS_REQUEST',
    documentNumber: DOCUMENT_NUMBER,
    documentType: 'IN',
    lineCount: 2,
    currency: 'SAR',
    netAmount: '100.00',
    taxAmount: '15.00',
    totalAmount: '115.00',
    taxSummaries: [
      { category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 },
      { category: 'Z', rate: '0.00', reasonCode: 'VATEX-SA-32', lineCount: 1 },
    ],
    requestByteCount: 701,
    requestSha256: HASH_A,
    endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
    attemptNumber: 2,
    timeoutMs: 8000,
  };
}

function oeisResponse(latencyMs = 25, overrides = {}) {
  return {
    kind: 'OEIS_RESPONSE',
    httpStatus: 202,
    isSystemException: false,
    validationResult: 'VALID',
    reportingStatus: 'PENDING',
    clearanceStatus: null,
    invoiceNumber: DOCUMENT_NUMBER,
    transactionNumber: 'TRAN-42',
    uuid: UUID,
    invoiceCounter: '1042',
    matchingKey: 'MATCH-42',
    validationCodes: ['VALIDATED'],
    responseByteCount: null,
    responseSha256: null,
    retryable: false,
    latencyMs,
    ...overrides,
  };
}

function artifactSummary() {
  return {
    kind: 'OEIS_ARTIFACT',
    signedXmlPresent: true,
    signedXmlByteCount: 2048,
    signedXmlSha256: HASH_A,
    qrPresent: true,
    qrByteCount: 128,
    qrSha256: HASH_B,
  };
}

function summaryPlacement(action, outcome, latencyMs) {
  if (action === 'FYND_LOCK_REQUESTED') return { requestSummary: fyndRequest('LOCK'), responseSummary: null };
  if (action === 'FYND_LOCK_CONFIRMED' || action === 'FYND_LOCK_FAILED') {
    return { requestSummary: null, responseSummary: fyndResponse('LOCK', latencyMs) };
  }
  if (action === 'FYND_LOCK_READBACK') {
    return outcome === 'STARTED'
      ? { requestSummary: fyndRequest('LOCK_READBACK'), responseSummary: null }
      : { requestSummary: null, responseSummary: fyndResponse('LOCK_READBACK', latencyMs) };
  }
  if (action === 'FYND_TRANSITION_REQUESTED') {
    return { requestSummary: fyndRequest('TRANSITION'), responseSummary: null };
  }
  if (action === 'FYND_TRANSITION_CONFIRMED' || action === 'FYND_TRANSITION_FAILED') {
    return { requestSummary: null, responseSummary: fyndResponse('TRANSITION', latencyMs) };
  }
  if (action === 'FYND_TRANSITION_READBACK') {
    return outcome === 'STARTED'
      ? { requestSummary: fyndRequest('TRANSITION_READBACK'), responseSummary: null }
      : { requestSummary: null, responseSummary: fyndResponse('TRANSITION_READBACK', latencyMs) };
  }
  if (action === 'OEIS_SUBMISSION_REQUESTED') return { requestSummary: oeisRequest(), responseSummary: null };
  if (action === 'OEIS_RESPONSE_RECEIVED' || action === 'OEIS_SUBMISSION_FAILED') {
    return { requestSummary: null, responseSummary: oeisResponse(latencyMs) };
  }
  if (action === 'OEIS_ARTIFACT_STORED') return { requestSummary: null, responseSummary: artifactSummary() };
  return { requestSummary: null, responseSummary: null };
}

function timelineItem(overrides = {}) {
  const outcome = overrides.outcome || 'SUCCESS';
  const action = overrides.action || 'WEBHOOK_RECEIVED';
  const stage = overrides.stage || 'WEBHOOK';
  const occurredAt = overrides.occurredAt || '2026-08-17T10:00:00.000Z';
  const isStarted = outcome === 'STARTED';
  const startedAt = isStarted ? occurredAt : '2026-08-17T09:59:59.975Z';
  const completedAt = isStarted ? null : '2026-08-17T10:00:00.000Z';
  const durationMs = isStarted ? null : 25;
  const summaries = summaryPlacement(action, outcome, durationMs);
  return {
    jobId: 42,
    documentNumber: DOCUMENT_NUMBER,
    stage,
    action,
    outcome,
    attemptNumber: 2,
    startedAt,
    completedAt,
    durationMs,
    queueDelayMs: action === 'JOB_CLAIMED' || action === 'OUTBOX_CLAIMED' ? 75 : null,
    retryDelayMs: action === 'RETRY_SCHEDULED' ? 1000 : null,
    nextAttemptAt: action === 'RETRY_SCHEDULED' ? '2026-08-17T10:00:01.000Z' : null,
    safeCode: ['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(outcome) ? 'SAFE_FAILURE' : null,
    requestSummary: summaries.requestSummary,
    responseSummary: summaries.responseSummary,
    artifactJobId: action === 'OEIS_ARTIFACT_STORED' ? 42 : null,
    occurredAt,
    ...overrides,
  };
}

function textResponse(body, status = 200) {
  return { status, data: JSON.stringify(body) };
}

function errorExpectation(kind) {
  const copy = {
    unauthorized: 'Your session has expired. Reauthenticate in Fynd to view shipment activity.',
    'not-found': 'This shipment activity is no longer available.',
    'request-failed': 'Shipment activity could not be loaded.',
  }[kind];
  return { kind, message: copy };
}

describe('shipment activity API client', () => {
  let mock;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
  });

  test('uses exact same-origin GET contracts and preserves raw response text', async () => {
    mock.onGet(RECENT_URL).reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.params).toEqual({ limit: 25, before: HEAD_CURSOR });
      expect(config.responseType).toBe('text');
      expect(config.transformResponse).toHaveLength(1);
      expect(config.transformResponse[0]('{"raw":true}')).toBe('{"raw":true}');
      expect(config.validateStatus(401)).toBe(true);
      expect(config.validateStatus(503)).toBe(true);
      return [200, JSON.stringify({ items: [], nextBefore: null })];
    });
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`).reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.params).toEqual({ limit: 50, before: TIMELINE_CURSOR });
      expect(config.responseType).toBe('text');
      return [200, JSON.stringify({ shipmentId: SHIPMENT_ID, items: [], nextBefore: null })];
    });

    await expect(listShipmentActivity({ companyId: 12655, limit: 25, before: HEAD_CURSOR }))
      .resolves.toEqual({ items: [], nextBefore: null });
    await expect(getShipmentTimeline({
      companyId: '12655', shipmentId: SHIPMENT_ID, before: TIMELINE_CURSOR,
    })).resolves.toEqual({ shipmentId: SHIPMENT_ID, items: [], nextBefore: null });
  });

  test('projects pre-job failures through the strict audit-head contract', async () => {
    const serverItem = preJobFailureItem();
    mock.onGet(PRE_JOB_FAILURES_URL).reply(config => {
      expect(config.headers['x-company-id']).toBe('12655');
      expect(config.params).toEqual({ limit: 17, before: HEAD_CURSOR });
      expect(config.responseType).toBe('text');
      return [200, JSON.stringify({
        items: [serverItem],
        nextBefore: 'bmV4dF9wcmVqb2JfMA',
      })];
    });

    const result = await listPreJobFailures({
      companyId: '12655',
      limit: 17,
      before: HEAD_CURSOR,
    });

    expect(result).toEqual({
      items: [preJobFailureItem()],
      nextBefore: 'bmV4dF9wcmVqb2JfMA',
    });
    expect(result.items[0]).not.toBe(serverItem);
    expect(Object.keys(result.items[0])).toEqual([
      'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction', 'lastOutcome',
      'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  test('accepts a validation failure as the latest pre-job audit head', async () => {
    const validationFailure = preJobFailureItem({
      shipmentId: 'shipment:validation-rejected',
      lastStage: 'VALIDATION',
      lastAction: 'VALIDATION_FAILED',
      lastSafeCode: 'CURRENCY_UNSUPPORTED',
    });
    mock.onGet(PRE_JOB_FAILURES_URL).reply(200, JSON.stringify({
      items: [validationFailure],
      nextBefore: null,
    }));

    await expect(listPreJobFailures({ companyId: '12655' })).resolves.toEqual({
      items: [validationFailure],
      nextBefore: null,
    });
  });

  test.each([
    ['job identity', preJobFailureItem({ jobId: 42 })],
    ['document identity', preJobFailureItem({ documentNumber: DOCUMENT_NUMBER })],
    ['non-failure outcome', preJobFailureItem({
      lastAction: 'WEBHOOK_ACCEPTED', lastOutcome: 'SUCCESS', lastSafeCode: null,
    })],
    ['wrong rejected stage', preJobFailureItem({
      lastStage: 'JOB', lastAction: 'JOB_DATA_FAILED', jobId: null,
    })],
    ['private payload field', { ...preJobFailureItem(), rawPayload: '<script>steal()</script>' }],
  ])('rejects malicious pre-job %s with a fixed safe error', async (_case, item) => {
    mock.onGet(PRE_JOB_FAILURES_URL).reply(200, JSON.stringify({ items: [item], nextBefore: null }));

    let caught;
    try {
      await listPreJobFailures({ companyId: '12655' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject(errorExpectation('request-failed'));
    expect(JSON.stringify(caught)).not.toMatch(/rawPayload|script|steal|documentNumber/);
  });

  test('validates pre-job inputs before Axios and sanitizes HTTP and network failures', async () => {
    await expect(listPreJobFailures({ companyId: '12655', limit: 0 }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(mock.history.get).toHaveLength(0);

    mock.onGet(PRE_JOB_FAILURES_URL).replyOnce(401, 'PRIVATE-AUTH-BODY');
    mock.onGet(PRE_JOB_FAILURES_URL).networkErrorOnce();
    await expect(listPreJobFailures({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('unauthorized'));
    await expect(listPreJobFailures({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
  });

  test('validates canonical Base64URL cursors without decoding their opaque bytes', async () => {
    const atob = jest.spyOn(global, 'atob').mockImplementation(() => {
      throw new Error('cursor bytes must stay opaque');
    });
    const btoa = jest.spyOn(global, 'btoa').mockImplementation(() => {
      throw new Error('cursor bytes must stay opaque');
    });
    mock.onGet(RECENT_URL).reply(200, JSON.stringify({ items: [], nextBefore: null }));

    await expect(listShipmentActivity({ companyId: '12655', before: HEAD_CURSOR }))
      .resolves.toEqual({ items: [], nextBefore: null });
    expect(atob).not.toHaveBeenCalled();
    expect(btoa).not.toHaveBeenCalled();
  });

  test('omits nullable cursors and applies exact default page limits', async () => {
    mock.onGet(RECENT_URL).reply(config => {
      expect(config.params).toEqual({ limit: 20 });
      return [200, JSON.stringify({ items: [], nextBefore: null })];
    });
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`).reply(config => {
      expect(config.params).toEqual({ limit: 50 });
      return [200, JSON.stringify({ shipmentId: SHIPMENT_ID, items: [], nextBefore: null })];
    });

    await listShipmentActivity({ companyId: '12655' });
    await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });
  });

  test('returns fresh deeply frozen exact recent and timeline projections', async () => {
    const serverHead = recentItem();
    const serverEvent = timelineItem({
      stage: 'OEIS_SUBMISSION',
      action: 'OEIS_RESPONSE_RECEIVED',
      responseSummary: oeisResponse(25),
    });
    const parsedRecent = { items: [serverHead], nextBefore: 'bmV4dF9oZWFkXzA' };
    const parsedTimeline = { shipmentId: SHIPMENT_ID, items: [serverEvent], nextBefore: 'bmV4dF90aW1lbGluZV8w' };
    mock.restore();
    jest.spyOn(axios, 'get')
      .mockResolvedValueOnce({ status: 200, data: '{"recent":true}' })
      .mockResolvedValueOnce({ status: 200, data: '{"timeline":true}' });
    const parse = jest.spyOn(JSON, 'parse')
      .mockReturnValueOnce(parsedRecent)
      .mockReturnValueOnce(parsedTimeline);

    const recent = await listShipmentActivity({ companyId: '12655' });
    const timeline = await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });

    expect(recent).toEqual(parsedRecent);
    expect(timeline).toEqual(parsedTimeline);
    expect(recent).not.toBe(parsedRecent);
    expect(recent.items).not.toBe(parsedRecent.items);
    expect(recent.items[0]).not.toBe(serverHead);
    expect(timeline).not.toBe(parsedTimeline);
    expect(timeline.items).not.toBe(parsedTimeline.items);
    expect(timeline.items[0]).not.toBe(serverEvent);
    expect(timeline.items[0].responseSummary).not.toBe(serverEvent.responseSummary);
    expect(timeline.items[0].responseSummary.validationCodes)
      .not.toBe(serverEvent.responseSummary.validationCodes);
    for (const value of [
      recent, recent.items, recent.items[0], timeline, timeline.items, timeline.items[0],
      timeline.items[0].responseSummary, timeline.items[0].responseSummary.validationCodes,
    ]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(recent.items[0])).toEqual([
      'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction', 'lastOutcome',
      'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
    ]);
    expect(Object.keys(timeline.items[0])).toEqual([
      'jobId', 'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber',
      'startedAt', 'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs',
      'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary', 'artifactJobId',
      'occurredAt',
    ]);
    parse.mockRestore();
  });

  test('accepts every frozen Task 3 action/outcome pair with matching evidence placement', async () => {
    const items = ACTION_CASES.map(([stage, action, outcome], index) => {
      const occurredAt = new Date(Date.UTC(2026, 7, 17, 10, 0, index)).toISOString();
      const completedAt = outcome === 'STARTED' ? null : occurredAt;
      const startedAt = outcome === 'STARTED'
        ? occurredAt
        : new Date(Date.parse(occurredAt) - 25).toISOString();
      return timelineItem({
        stage,
        action,
        outcome,
        occurredAt,
        startedAt,
        completedAt,
        durationMs: outcome === 'STARTED' ? null : 25,
        nextAttemptAt: action === 'RETRY_SCHEDULED'
          ? new Date(Date.parse(occurredAt) + 1000).toISOString()
          : null,
        ...summaryPlacement(action, outcome, outcome === 'STARTED' ? null : 25),
      });
    });
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`)
      .reply(200, JSON.stringify({ shipmentId: SHIPMENT_ID, items, nextBefore: null }));

    const result = await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });

    expect(result.items).toHaveLength(ACTION_CASES.length);
    expect(result.items.map(item => [item.stage, item.action, item.outcome])).toEqual(ACTION_CASES);
  });

  test('accepts every public nullable field and preserves identical public events in server order', async () => {
    const duplicate = timelineItem({
      jobId: null,
      documentNumber: null,
      attemptNumber: 0,
      safeCode: null,
      artifactJobId: null,
    });
    mock.onGet(RECENT_URL).reply(200, JSON.stringify({
      items: [recentItem({ jobId: null, documentNumber: null, lastSafeCode: null })],
      nextBefore: null,
    }));
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`).reply(200, JSON.stringify({
      shipmentId: SHIPMENT_ID,
      items: [duplicate, duplicate],
      nextBefore: null,
    }));

    const recent = await listShipmentActivity({ companyId: '12655' });
    const timeline = await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });

    expect(recent.items[0]).toEqual(recentItem({ jobId: null, documentNumber: null, lastSafeCode: null }));
    expect(timeline.items).toEqual([duplicate, duplicate]);
    expect(timeline.items[0]).not.toBe(timeline.items[1]);
  });

  test('accepts the five exact safe-summary families and copies nested rows', async () => {
    const summaries = [
      timelineItem({
        stage: 'FYND_LOCK', action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
        completedAt: null, durationMs: null, requestSummary: fyndRequest('LOCK'), responseSummary: null,
      }),
      timelineItem({
        stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED',
        requestSummary: null, responseSummary: fyndResponse('LOCK'),
      }),
      timelineItem({
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_REQUESTED', outcome: 'STARTED',
        completedAt: null, durationMs: null, requestSummary: oeisRequest(), responseSummary: null,
      }),
      timelineItem({
        stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED',
        requestSummary: null, responseSummary: oeisResponse(),
      }),
      timelineItem({
        stage: 'OEIS_ARTIFACT', action: 'OEIS_ARTIFACT_STORED', artifactJobId: 42,
        requestSummary: null, responseSummary: artifactSummary(),
      }),
    ].map((item, index) => ({
      ...item,
      occurredAt: new Date(Date.UTC(2026, 7, 17, 10, index, 0)).toISOString(),
    }));
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`).reply(200, JSON.stringify({
      shipmentId: SHIPMENT_ID, items: summaries, nextBefore: null,
    }));

    const result = await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });

    expect(result.items.map(item => item.requestSummary?.kind || item.responseSummary?.kind)).toEqual([
      'FYND_REQUEST', 'FYND_RESPONSE', 'OEIS_REQUEST', 'OEIS_RESPONSE', 'OEIS_ARTIFACT',
    ]);
    expect(Object.isFrozen(result.items[2].requestSummary.taxSummaries)).toBe(true);
    expect(Object.isFrozen(result.items[2].requestSummary.taxSummaries[0])).toBe(true);
  });

  test.each([
    ['missing options', undefined, 'list'],
    ['null options', null, 'list'],
    ['array options', [], 'list'],
    ['class options', new (class Options { constructor() { this.companyId = '12655'; } })(), 'list'],
    ['missing company', {}, 'list'],
    ['zero company', { companyId: 0 }, 'list'],
    ['unsafe company', { companyId: Number.MAX_SAFE_INTEGER + 1 }, 'list'],
    ['leading-zero company', { companyId: '012655' }, 'list'],
    ['boxed company', { companyId: new String('12655') }, 'list'],
    ['blank company', { companyId: ' 12655' }, 'list'],
    ['oversized company', { companyId: '1'.repeat(65) }, 'list'],
    ['zero limit', { companyId: '12655', limit: 0 }, 'list'],
    ['fractional limit', { companyId: '12655', limit: 1.5 }, 'list'],
    ['oversized limit', { companyId: '12655', limit: 51 }, 'list'],
    ['boxed limit', { companyId: '12655', limit: new Number(20) }, 'list'],
    ['empty cursor', { companyId: '12655', before: '' }, 'list'],
    ['padded cursor', { companyId: '12655', before: 'abc=' }, 'list'],
    ['standard-base64 cursor', { companyId: '12655', before: 'abc+' }, 'list'],
    ['noncanonical cursor length', { companyId: '12655', before: 'a' }, 'list'],
    ['noncanonical cursor trailing bits', { companyId: '12655', before: '_B' }, 'list'],
    ['oversized cursor', { companyId: '12655', before: 'a'.repeat(1025) }, 'list'],
    ['extra list input', { companyId: '12655', debug: true }, 'list'],
    ['missing shipment', { companyId: '12655' }, 'timeline'],
    ['blank shipment', { companyId: '12655', shipmentId: '' }, 'timeline'],
    ['unsafe shipment alphabet', { companyId: '12655', shipmentId: 'shipment/1' }, 'timeline'],
    ['oversized shipment', { companyId: '12655', shipmentId: 's'.repeat(513) }, 'timeline'],
    ['boxed shipment', { companyId: '12655', shipmentId: new String('shipment-1') }, 'timeline'],
  ])('rejects %s before Axios is called', async (_case, input, operation) => {
    const request = operation === 'list'
      ? listShipmentActivity(input)
      : getShipmentTimeline(input);
    await expect(request).rejects.toMatchObject(errorExpectation('request-failed'));
    expect(mock.history.get).toHaveLength(0);
  });

  test('rejects accessor and inherited inputs without evaluating them or calling Axios', async () => {
    const getter = jest.fn(() => '12655');
    const accessor = {};
    Object.defineProperty(accessor, 'companyId', { enumerable: true, get: getter });
    const inherited = Object.assign(Object.create({ companyId: '12655' }), { limit: 20 });

    await expect(listShipmentActivity(accessor)).rejects.toMatchObject(errorExpectation('request-failed'));
    await expect(listShipmentActivity(inherited)).rejects.toMatchObject(errorExpectation('request-failed'));
    expect(getter).not.toHaveBeenCalled();
    expect(mock.history.get).toHaveLength(0);
  });

  test('sanitizes a hostile validation throw without reading its kind getter', async () => {
    const kindGetter = jest.fn(() => { throw new Error('private getter value'); });
    const hostile = {};
    Object.defineProperty(hostile, 'kind', { get: kindGetter });
    const input = new Proxy({}, {
      getPrototypeOf() { throw hostile; },
    });

    await expect(listShipmentActivity(input))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(kindGetter).not.toHaveBeenCalled();
    expect(mock.history.get).toHaveLength(0);
  });

  test.each([
    ['null recent page', null, 'list'],
    ['array recent page', [], 'list'],
    ['extra recent page key', { items: [], nextBefore: null, eventKey: 'private' }, 'list'],
    ['missing recent cursor', { items: [] }, 'list'],
    ['non-array recent items', { items: {}, nextBefore: null }, 'list'],
    ['invalid recent cursor', { items: [], nextBefore: 'bad=' }, 'list'],
    ['extra head property', { items: [recentItem({ companyId: '12655' })], nextBefore: null }, 'list'],
    ['duplicate head shipment', { items: [recentItem(), recentItem({ lastOccurredAt: '2026-08-17T09:59:00.000Z' })], nextBefore: null }, 'list'],
    ['ascending recent order', { items: [recentItem({ shipmentId: 'shipment-2', lastOccurredAt: '2026-08-17T09:00:00.000Z' }), recentItem({ shipmentId: 'shipment-1', lastOccurredAt: '2026-08-17T10:00:00.000Z' })], nextBefore: null }, 'list'],
    ['head first after last', { items: [recentItem({ firstOccurredAt: '2026-08-17T11:00:00.000Z' })], nextBefore: null }, 'list'],
    ['invalid head action pair', { items: [recentItem({ lastAction: 'JOB_COMPLETED', lastOutcome: 'FAILURE' })], nextBefore: null }, 'list'],
    ['failure head without code', { items: [recentItem({ lastStage: 'JOB', lastAction: 'JOB_DATA_FAILED', lastOutcome: 'FAILURE', lastSafeCode: null })], nextBefore: null }, 'list'],
    ['timeline shipment mismatch', { shipmentId: 'other-shipment', items: [], nextBefore: null }, 'timeline'],
    ['extra timeline key', { shipmentId: SHIPMENT_ID, items: [], nextBefore: null, eventKey: 'private' }, 'timeline'],
    ['descending timeline order', { shipmentId: SHIPMENT_ID, items: [timelineItem({ occurredAt: '2026-08-17T10:00:01.000Z' }), timelineItem({ occurredAt: '2026-08-17T10:00:00.000Z' })], nextBefore: null }, 'timeline'],
    ['invalid event action pair', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'FAILURE', safeCode: 'FAILED' })], nextBefore: null }, 'timeline'],
    ['failure event without code', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: null })], nextBefore: null }, 'timeline'],
    ['started event with completion', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'VALIDATION', action: 'VALIDATION_STARTED', outcome: 'STARTED', completedAt: '2026-08-17T10:00:00.000Z', durationMs: 0 })], nextBefore: null }, 'timeline'],
    ['duration drift', { shipmentId: SHIPMENT_ID, items: [timelineItem({ durationMs: 24 })], nextBefore: null }, 'timeline'],
    ['queue delay on nonclaim', { shipmentId: SHIPMENT_ID, items: [timelineItem({ queueDelayMs: 1 })], nextBefore: null }, 'timeline'],
    ['missing claim queue delay', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'JOB', action: 'JOB_CLAIMED', queueDelayMs: null })], nextBefore: null }, 'timeline'],
    ['retry delay drift', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED', retryDelayMs: 1000, nextAttemptAt: '2026-08-17T10:00:02.000Z' })], nextBefore: null }, 'timeline'],
    ['summary in wrong slot', { shipmentId: SHIPMENT_ID, items: [timelineItem({ requestSummary: fyndRequest('LOCK') })], nextBefore: null }, 'timeline'],
    ['summary latency drift', { shipmentId: SHIPMENT_ID, items: [timelineItem({ stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED', responseSummary: fyndResponse('LOCK', 24) })], nextBefore: null }, 'timeline'],
  ])('maps invalid public schema to a fixed request failure: %s', async (_case, body, operation) => {
    const url = operation === 'list'
      ? RECENT_URL
      : `/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`;
    mock.onGet(url).reply(200, JSON.stringify(body));
    const request = operation === 'list'
      ? listShipmentActivity({ companyId: '12655' })
      : getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });
    await expect(request).rejects.toMatchObject(errorExpectation('request-failed'));
  });

  test.each([
    ['FYND request extra key', fyndRequest('LOCK'), { customerName: 'BUYER-SENTINEL' }],
    ['FYND response raw body', fyndResponse('LOCK'), { rawBody: 'RAW-BODY-SENTINEL' }],
    ['OEIS request authorization', oeisRequest(), { authorization: 'TOKEN-SENTINEL' }],
    ['OEIS response XML', oeisResponse(), { signedXml: 'XML-SENTINEL' }],
    ['artifact QR body', artifactSummary(), { qrBase64: 'QR-SENTINEL' }],
  ])('rejects %s without returning its sentinel', async (_case, summary, extra) => {
    const hostile = { ...summary, ...extra };
    const kind = summary.kind;
    let item;
    if (kind === 'FYND_REQUEST') {
      item = timelineItem({
        stage: 'FYND_LOCK', action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
        completedAt: null, durationMs: null, requestSummary: hostile, responseSummary: null,
      });
    } else if (kind === 'FYND_RESPONSE') {
      item = timelineItem({ stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED', responseSummary: hostile });
    } else if (kind === 'OEIS_REQUEST') {
      item = timelineItem({
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_REQUESTED', outcome: 'STARTED',
        completedAt: null, durationMs: null, requestSummary: hostile, responseSummary: null,
      });
    } else if (kind === 'OEIS_RESPONSE') {
      item = timelineItem({ stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', responseSummary: hostile });
    } else {
      item = timelineItem({
        stage: 'OEIS_ARTIFACT', action: 'OEIS_ARTIFACT_STORED', artifactJobId: 42,
        responseSummary: hostile,
      });
    }
    const raw = JSON.stringify({ shipmentId: SHIPMENT_ID, items: [item], nextBefore: null });
    mock.onGet(`/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`).reply(200, raw);

    let caught;
    try {
      await getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject(errorExpectation('request-failed'));
    expect(JSON.stringify(caught)).not.toMatch(/BUYER-SENTINEL|RAW-BODY-SENTINEL|TOKEN-SENTINEL|XML-SENTINEL|QR-SENTINEL/);
    expect(caught).not.toHaveProperty('response');
    expect(caught).not.toHaveProperty('request');
    expect(caught).not.toHaveProperty('config');
    expect(caught).not.toHaveProperty('cause');
  });

  test('rejects object response data without traversing its Proxy traps', async () => {
    const traps = { get: jest.fn(), ownKeys: jest.fn(), getPrototypeOf: jest.fn() };
    const payload = new Proxy({ items: [], nextBefore: null }, {
      get(target, key, receiver) { traps.get(); return Reflect.get(target, key, receiver); },
      ownKeys(target) { traps.ownKeys(); return Reflect.ownKeys(target); },
      getPrototypeOf(target) { traps.getPrototypeOf(); return Reflect.getPrototypeOf(target); },
    });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: payload });

    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
  });

  test('rejects response and parsed accessors without executing them', async () => {
    const responseGetter = jest.fn(() => '{"private":"RESPONSE-GETTER-SENTINEL"}');
    const response = { status: 200 };
    Object.defineProperty(response, 'data', { get: responseGetter });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce(response);

    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(responseGetter).not.toHaveBeenCalled();

    const nestedGetter = jest.fn(() => 'PARSED-GETTER-SENTINEL');
    const parsed = { items: [], nextBefore: null };
    Object.defineProperty(parsed, 'debug', { enumerable: true, get: nestedGetter });
    axios.get.mockResolvedValueOnce({ status: 200, data: '{"valid":true}' });
    jest.spyOn(JSON, 'parse').mockReturnValueOnce(parsed);
    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(nestedGetter).not.toHaveBeenCalled();
  });

  test.each([
    ['sparse recent array', new Array(1)],
    ['array with a hole', [, recentItem()]],
  ])('rejects a %s returned by JSON.parse', async (_case, items) => {
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: '{"valid":true}' });
    jest.spyOn(JSON, 'parse').mockReturnValueOnce({ items, nextBefore: null });

    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
  });

  test('measures the raw response as UTF-8 bytes and accepts the inclusive 512 KiB limit', async () => {
    const valid = JSON.stringify({ items: [], nextBefore: null });
    const exact = `${valid}${' '.repeat(524288 - Buffer.byteLength(valid, 'utf8'))}`;
    mock.onGet(RECENT_URL)
      .replyOnce(200, exact)
      .onGet(RECENT_URL)
      .replyOnce(200, `${exact} `);

    await expect(listShipmentActivity({ companyId: '12655' }))
      .resolves.toEqual({ items: [], nextBefore: null });
    const parse = jest.spyOn(JSON, 'parse');
    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();

    const multibyte = `"${'🌟'.repeat(131072)}"`;
    expect(multibyte.length).toBeLessThan(524288);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(524288);
    mock.onGet(RECENT_URL).replyOnce(200, multibyte);
    const multibyteParse = jest.spyOn(JSON, 'parse');
    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
    expect(multibyteParse).not.toHaveBeenCalled();
  });

  test('accepts a 4096-byte safe summary and rejects 4097 bytes', async () => {
    function sizedSummary(target) {
      for (let slashes = 1; slashes <= 512; slashes += 1) {
        const base = oeisResponse(25, {
          invoiceNumber: '\\'.repeat(512),
          transactionNumber: '\\'.repeat(512),
          invoiceCounter: '\\'.repeat(slashes),
          matchingKey: 'M',
          validationCodes: Array.from({ length: 20 }, (_, index) => `CODE_${String(index).padStart(2, '0')}_${'X'.repeat(54)}`),
        });
        const letters = target - Buffer.byteLength(JSON.stringify(base), 'utf8') + 1;
        if (letters < 1 || letters > 512) continue;
        const candidate = { ...base, matchingKey: 'M'.repeat(letters) };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') === target) return candidate;
      }
      throw new Error(`Unable to construct ${target}-byte summary fixture`);
    }
    const accepted = sizedSummary(4096);
    const rejected = { ...accepted, matchingKey: `${accepted.matchingKey}M` };
    expect(Buffer.byteLength(JSON.stringify(rejected), 'utf8')).toBe(4097);
    const url = `/api/einvoice/shipment-activity/${encodeURIComponent(SHIPMENT_ID)}`;
    mock.onGet(url)
      .replyOnce(200, JSON.stringify({
        shipmentId: SHIPMENT_ID,
        items: [timelineItem({ stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', responseSummary: accepted })],
        nextBefore: null,
      }))
      .onGet(url)
      .replyOnce(200, JSON.stringify({
        shipmentId: SHIPMENT_ID,
        items: [timelineItem({ stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', responseSummary: rejected })],
        nextBefore: null,
      }));

    await expect(getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID }))
      .resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ responseSummary: accepted })] }));
    await expect(getShipmentTimeline({ companyId: '12655', shipmentId: SHIPMENT_ID }))
      .rejects.toMatchObject(errorExpectation('request-failed'));
  });

  test.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [500, 'request-failed'],
  ])('maps HTTP %i before inspecting the raw body', async (status, kind) => {
    const bodyGetter = jest.fn(() => 'RAW-SERVER-BODY-SENTINEL');
    const response = { status };
    Object.defineProperty(response, 'data', { get: bodyGetter });
    mock.restore();
    jest.spyOn(axios, 'get').mockResolvedValueOnce(response);

    await expect(listShipmentActivity({ companyId: '12655' }))
      .rejects.toMatchObject(errorExpectation(kind));
    expect(bodyGetter).not.toHaveBeenCalled();
  });

  test('maps network failures, hostile errors, and malformed Axios responses to fixed safe errors', async () => {
    const responseGetter = jest.fn(() => { throw new Error('HOSTILE-ERROR-GETTER'); });
    const hostile = {};
    Object.defineProperty(hostile, 'response', { get: responseGetter });
    mock.restore();
    jest.spyOn(axios, 'get')
      .mockRejectedValueOnce(hostile)
      .mockResolvedValueOnce({ data: '{"items":[],"nextBefore":null}' })
      .mockResolvedValueOnce({ status: 200, data: '' })
      .mockResolvedValueOnce({ status: 200, data: '{' });

    for (let index = 0; index < 4; index += 1) {
      let caught;
      try {
        await listShipmentActivity({ companyId: '12655' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject(errorExpectation('request-failed'));
      expect(JSON.stringify(caught)).not.toMatch(/HOSTILE|items|nextBefore/);
      expect(caught).not.toHaveProperty('response');
      expect(caught).not.toHaveProperty('request');
      expect(caught).not.toHaveProperty('config');
      expect(caught).not.toHaveProperty('cause');
    }
    expect(responseGetter).not.toHaveBeenCalled();
  });
});
