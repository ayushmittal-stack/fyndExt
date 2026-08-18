'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  AUDIT_CURSOR_MAX_CHARS,
  encodeHeadCursor,
  decodeHeadCursor,
  encodeTimelineCursor,
  decodeTimelineCursor,
} = require('../../src/einvoice/audit/audit-cursor');

const HEAD_INPUT = Object.freeze({
  lastOccurredAt: '2026-08-17T12:34:56.789Z',
  shipmentId: 'shipment-2',
});
const HEAD_TOKEN = 'eyJ2IjoxLCJsYXN0T2NjdXJyZWRBdCI6IjIwMjYtMDgtMTdUMTI6MzQ6NTYuNzg5WiIsInNoaXBtZW50SWQiOiJzaGlwbWVudC0yIn0';
const EVENT_KEY = 'v1.EwovEofzvaliEJd25IoRY8LzxTXl9RXdbdNJKSwuH28';
const TIMELINE_INPUT = Object.freeze({
  occurredAt: '2026-08-17T12:34:56.789Z',
  eventKey: EVENT_KEY,
});
const TIMELINE_TOKEN = 'eyJ2IjoxLCJvY2N1cnJlZEF0IjoiMjAyNi0wOC0xN1QxMjozNDo1Ni43ODlaIiwiZXZlbnRLZXkiOiJ2MS5Fd292RW9menZhbGlFSmQyNUlvUlk4THp4VFhsOVJYZGJkTkpLU3d1SDI4In0';

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

function expectCursorError(operation) {
  const error = captureError(operation);
  expect(error).toBeInstanceOf(EinvoiceError);
  expect(error).toMatchObject({
    name: 'EinvoiceError',
    code: 'AUDIT_CURSOR_INVALID',
    message: 'Shipment activity cursor is invalid',
    retryable: false,
  });
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  return error;
}

function tokenForJson(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('opaque audit cursor round trips', () => {
  test('exports the exact maximum token length', () => {
    expect(AUDIT_CURSOR_MAX_CHARS).toBe(1_024);
  });

  test('matches the literal canonical head token and returns fresh frozen values', () => {
    const input = { ...HEAD_INPUT };
    expect(encodeHeadCursor(input)).toBe(HEAD_TOKEN);
    const first = decodeHeadCursor(HEAD_TOKEN);
    const second = decodeHeadCursor(HEAD_TOKEN);
    expect(first).toEqual(HEAD_INPUT);
    expect(Object.keys(first)).toEqual(['lastOccurredAt', 'shipmentId']);
    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(encodeHeadCursor(first)).toBe(HEAD_TOKEN);
  });

  test('matches the hand-pinned canonical timeline token and returns fresh frozen values', () => {
    const input = { ...TIMELINE_INPUT };
    expect(encodeTimelineCursor(input)).toBe(TIMELINE_TOKEN);
    const first = decodeTimelineCursor(TIMELINE_TOKEN);
    const second = decodeTimelineCursor(TIMELINE_TOKEN);
    expect(first).toEqual(TIMELINE_INPUT);
    expect(Object.keys(first)).toEqual(['occurredAt', 'eventKey']);
    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(encodeTimelineCursor(first)).toBe(TIMELINE_TOKEN);
  });

  test('encodes in canonical field order independent of caller insertion order', () => {
    expect(encodeHeadCursor({ shipmentId: 'shipment-2', lastOccurredAt: HEAD_INPUT.lastOccurredAt })).toBe(HEAD_TOKEN);
    expect(encodeTimelineCursor({ eventKey: EVENT_KEY, occurredAt: TIMELINE_INPUT.occurredAt })).toBe(TIMELINE_TOKEN);
  });

  test('cursors contain positioning only and reject company authorization data', () => {
    expect(Buffer.from(HEAD_TOKEN, 'base64url').toString('utf8')).toBe(
      '{"v":1,"lastOccurredAt":"2026-08-17T12:34:56.789Z","shipmentId":"shipment-2"}',
    );
    expect(Buffer.from(TIMELINE_TOKEN, 'base64url').toString('utf8')).toBe(
      `{"v":1,"occurredAt":"2026-08-17T12:34:56.789Z","eventKey":"${EVENT_KEY}"}`,
    );
    expectCursorError(() => encodeHeadCursor({ ...HEAD_INPUT, companyId: '15862' }));
    expectCursorError(() => encodeTimelineCursor({ ...TIMELINE_INPUT, companyId: '15862' }));
  });
});

describe('cursor encoding input validation', () => {
  test.each([
    null,
    [],
    Object.create(null),
    new (class Cursor {})(),
  ])('rejects non-plain input %#', input => {
    expectCursorError(() => encodeHeadCursor(input));
  });

  test('rejects missing, inherited, extra, and symbol fields', () => {
    const missing = { ...HEAD_INPUT };
    delete missing.shipmentId;
    expectCursorError(() => encodeHeadCursor(missing));

    const inherited = Object.create({ shipmentId: 'shipment-2' });
    inherited.lastOccurredAt = HEAD_INPUT.lastOccurredAt;
    expectCursorError(() => encodeHeadCursor(inherited));

    expectCursorError(() => encodeHeadCursor({ ...HEAD_INPUT, extra: true }));
    const symbol = { ...HEAD_INPUT };
    symbol[Symbol('secret')] = 'never';
    expectCursorError(() => encodeHeadCursor(symbol));
  });

  test('rejects accessors and proxies without executing attacker code', () => {
    const accessorCounter = { calls: 0 };
    const accessor = { shipmentId: 'shipment-2' };
    Object.defineProperty(accessor, 'lastOccurredAt', {
      enumerable: true,
      get() { accessorCounter.calls += 1; return HEAD_INPUT.lastOccurredAt; },
    });
    expectCursorError(() => encodeHeadCursor(accessor));
    expect(accessorCounter.calls).toBe(0);

    const proxyCounter = { calls: 0 };
    const proxy = new Proxy({ ...HEAD_INPUT }, {
      get() { proxyCounter.calls += 1; return 'secret'; },
      ownKeys() { proxyCounter.calls += 1; return []; },
      getOwnPropertyDescriptor() { proxyCounter.calls += 1; return undefined; },
      getPrototypeOf() { proxyCounter.calls += 1; return Object.prototype; },
    });
    expectCursorError(() => encodeHeadCursor(proxy));
    expect(proxyCounter.calls).toBe(0);
  });

  test.each([
    '',
    ' ',
    'contains\ncontrol',
    'é',
    'x'.repeat(513),
  ])('rejects unsafe shipment identifier %j', shipmentId => {
    expectCursorError(() => encodeHeadCursor({ ...HEAD_INPUT, shipmentId }));
  });

  test.each([
    '2026-08-17T12:34:56Z',
    '2026-08-17T12:34:56.789+00:00',
    '2026-08-17t12:34:56.789z',
    '2026-02-30T12:34:56.789Z',
    'not-a-date',
    new Date('2026-08-17T12:34:56.789Z'),
  ])('rejects noncanonical timestamp input %#', timestamp => {
    expectCursorError(() => encodeHeadCursor({ ...HEAD_INPUT, lastOccurredAt: timestamp }));
    expectCursorError(() => encodeTimelineCursor({ ...TIMELINE_INPUT, occurredAt: timestamp }));
  });

  test.each([
    '',
    'v1.short',
    'v2.EwovEofzvaliEJd25IoRY8LzxTXl9RXdbdNJKSwuH28',
    'v1.EwovEofzvaliEJd25IoRY8LzxTXl9RXdbdNJKSwuH2+',
    'v1.EwovEofzvaliEJd25IoRY8LzxTXl9RXdbdNJKSwuH28=',
  ])('rejects invalid timeline event key %j', eventKey => {
    expectCursorError(() => encodeTimelineCursor({ ...TIMELINE_INPUT, eventKey }));
  });

  test('keeps a maximum-length unescaped shipment ID under the token cap', () => {
    const token = encodeHeadCursor({ ...HEAD_INPUT, shipmentId: 'x'.repeat(512) });
    expect(token.length).toBeLessThanOrEqual(AUDIT_CURSOR_MAX_CHARS);
    expect(decodeHeadCursor(token)).toEqual({
      lastOccurredAt: HEAD_INPUT.lastOccurredAt,
      shipmentId: 'x'.repeat(512),
    });
  });

  test('rejects an otherwise valid escaped identifier when its canonical token exceeds 1024 characters', () => {
    expectCursorError(() => encodeHeadCursor({ ...HEAD_INPUT, shipmentId: '\\'.repeat(512) }));
  });
});

describe('cursor decoding canonicality and kind isolation', () => {
  test.each([
    null,
    undefined,
    1,
    '',
    ' ',
    `${HEAD_TOKEN}=`,
    ` ${HEAD_TOKEN}`,
    `${HEAD_TOKEN}\n`,
    'A',
    '+w',
    '/w',
    'A'.repeat(1_025),
  ])('rejects malformed token %#', token => {
    expectCursorError(() => decodeHeadCursor(token));
  });

  test('rejects invalid UTF-8, BOM, non-JSON, arrays, null, and primitive JSON', () => {
    for (const token of [
      Buffer.from([0xff]).toString('base64url'),
      tokenForJson(`\uFEFF${JSON.stringify({ v: 1, ...HEAD_INPUT })}`),
      tokenForJson('{'),
      tokenForJson('[]'),
      tokenForJson('null'),
      tokenForJson('1'),
    ]) {
      expectCursorError(() => decodeHeadCursor(token));
    }
  });

  test('rejects alternate order, duplicate keys, escapes, whitespace, and noncanonical Base64URL encodings', () => {
    const variants = [
      '{"shipmentId":"shipment-2","lastOccurredAt":"2026-08-17T12:34:56.789Z","v":1}',
      '{"v":1,"v":1,"lastOccurredAt":"2026-08-17T12:34:56.789Z","shipmentId":"shipment-2"}',
      '{"\\u0076":1,"lastOccurredAt":"2026-08-17T12:34:56.789Z","shipmentId":"shipment-2"}',
      '{ "v":1,"lastOccurredAt":"2026-08-17T12:34:56.789Z","shipmentId":"shipment-2"}',
      '{"v":1,"lastOccurredAt":"2026-08-17T12:34:56.789Z","shipmentId":"shipment-\\u0032"}',
    ];
    for (const json of variants) expectCursorError(() => decodeHeadCursor(tokenForJson(json)));

    // Same bytes with an impossible extra zero sextet must not be accepted by permissive decoders.
    expectCursorError(() => decodeHeadCursor(`${HEAD_TOKEN}A`));
  });

  test.each([
    ['wrong version', { v: 2, ...HEAD_INPUT }],
    ['string version', { v: '1', ...HEAD_INPUT }],
    ['missing field', { v: 1, lastOccurredAt: HEAD_INPUT.lastOccurredAt }],
    ['extra field', { v: 1, ...HEAD_INPUT, extra: true }],
    ['company ID', { v: 1, ...HEAD_INPUT, companyId: '15862' }],
    ['timeline field', { v: 1, ...HEAD_INPUT, eventKey: EVENT_KEY }],
  ])('rejects noncanonical head JSON shape: %s', (_description, value) => {
    expectCursorError(() => decodeHeadCursor(tokenForJson(JSON.stringify(value))));
  });

  test.each([
    ['wrong version', { v: 2, ...TIMELINE_INPUT }],
    ['missing field', { v: 1, occurredAt: TIMELINE_INPUT.occurredAt }],
    ['extra field', { v: 1, ...TIMELINE_INPUT, extra: true }],
    ['company ID', { v: 1, ...TIMELINE_INPUT, companyId: '15862' }],
    ['head field', { v: 1, ...TIMELINE_INPUT, shipmentId: 'shipment-2' }],
  ])('rejects noncanonical timeline JSON shape: %s', (_description, value) => {
    expectCursorError(() => decodeTimelineCursor(tokenForJson(JSON.stringify(value))));
  });

  test('rejects cross-kind canonical tokens', () => {
    expectCursorError(() => decodeHeadCursor(TIMELINE_TOKEN));
    expectCursorError(() => decodeTimelineCursor(HEAD_TOKEN));
  });

  test('revalidates decoded timestamps, shipment IDs, and event keys', () => {
    expectCursorError(() => decodeHeadCursor(tokenForJson(JSON.stringify({
      v: 1, lastOccurredAt: '2026-08-17T12:34:56Z', shipmentId: 'shipment-2',
    }))));
    expectCursorError(() => decodeHeadCursor(tokenForJson(JSON.stringify({
      v: 1, lastOccurredAt: HEAD_INPUT.lastOccurredAt, shipmentId: 'contains\ncontrol',
    }))));
    expectCursorError(() => decodeTimelineCursor(tokenForJson(JSON.stringify({
      v: 1, occurredAt: TIMELINE_INPUT.occurredAt, eventKey: 'v1.short',
    }))));
  });

  test('never exposes hostile token text in its fixed error', () => {
    const sentinel = 'buyer-name-token-secret';
    const error = expectCursorError(() => decodeHeadCursor(tokenForJson(sentinel)));
    expect(`${error.code} ${error.message}`).not.toContain(sentinel);
  });
});
