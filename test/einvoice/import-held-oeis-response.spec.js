'use strict';

const { parseArguments } = require('../../scripts/import-held-oeis-response');

test('requires the exact one-shot held-response import confirmation and identifiers', () => {
  expect(parseArguments([
    '--response', '/tmp/response.json', '--company', '15862', '--shipment', '17865235357191757038',
    '--job-id', '7', '--expected-version', '4',
    '--previous-request-hash', 'a'.repeat(64),
    '--confirm', 'IMPORT_HELD_RESPONSE_WITHOUT_OEIS_RESUBMISSION',
  ])).toEqual({
    responsePath: '/tmp/response.json', companyId: '15862', shipmentId: '17865235357191757038',
    jobId: 7, expectedVersion: 4, previousRequestHash: 'a'.repeat(64),
  });
});

test.each([
  [[[]]],
  ['--response', 'relative.json'],
  ['--response', '/tmp/response.json', '--company', '15862', '--shipment', '1', '--job-id', '7', '--expected-version', '4', '--previous-request-hash', 'a'.repeat(64), '--confirm', 'WRONG'],
])('rejects incomplete or unconfirmed input without reading files or environment', argv => {
  expect(() => parseArguments(argv)).toThrow(expect.objectContaining({
    code: 'MANUAL_IMPORT_INPUT_INVALID',
  }));
});
