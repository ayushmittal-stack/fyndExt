'use strict';

const { addMoney, formatMoney, multiplyMoney, parseMoney, withinTolerance } = require('../../src/einvoice/decimal');

test('adds and multiplies SAR values without floating point drift', () => {
  expect(addMoney('0.10', '0.20')).toBe('0.30');
  expect(multiplyMoney('33.33', 3)).toBe('99.99');
});

test('rejects more than two non-zero money decimals', () => {
  expect(() => parseMoney('1.001')).toThrow(expect.objectContaining({ code: 'MONEY_PRECISION_INVALID' }));
});

test('formats signed cents and compares exact cent tolerances', () => {
  expect(formatMoney(-1n)).toBe('-0.01');
  expect(formatMoney(-1205n)).toBe('-12.05');
  expect(withinTolerance('10.00', '10.01', '0.01')).toBe(true);
  expect(withinTolerance('10.00', '10.02', '0.01')).toBe(false);
  expect(() => withinTolerance('10.00', '10.00', '-0.01'))
    .toThrow(expect.objectContaining({ code: 'MONEY_TOLERANCE_INVALID' }));
});
