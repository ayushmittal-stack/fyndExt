'use strict';

const crypto = require('crypto');
const { EinvoiceError } = require('./errors');
const { formatMoney, parseMoney } = require('./decimal');

const RIYADH_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
});

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMoney(value, code, message, { positive = false } = {}) {
  let cents;
  try {
    cents = parseMoney(value);
  } catch {
    fail(code, message);
  }
  if (cents < 0n || (positive && cents === 0n)) fail(code, message);
  return cents;
}

function validatePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('SHIPMENT_QUANTITY_INVALID', 'Bag quantity must be positive');
  }
  return value;
}

function requireNonEmptyString(value, code, message) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, message);
  return value;
}

function requireMasterData(masterData) {
  if (!isObject(masterData) || typeof masterData.getBranch !== 'function' || typeof masterData.getProduct !== 'function') {
    fail('MASTER_DATA_INVALID', 'Approved master data is invalid');
  }
  return masterData;
}

function requireTaxPolicyResolver(taxPolicyResolver) {
  if (!isObject(taxPolicyResolver) || typeof taxPolicyResolver.resolveLineTax !== 'function') {
    fail('PAYLOAD_CONFIG_INVALID', 'Healthcare tax policy resolver is invalid');
  }
  return taxPolicyResolver;
}

function getRiyadhDate(confirmedAt) {
  const match = typeof confirmedAt === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(confirmedAt);
  if (!match) fail('SHIPMENT_CONFIRMED_AT_INVALID', 'Shipment confirmed timestamp is invalid');
  const [, year, month, day, hour, minute, second, offset] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (numericMonth < 1 || numericMonth > 12
      || numericDay < 1 || numericDay > new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
      || numericHour > 23 || numericMinute > 59 || numericSecond > 59
      || offsetHour > 23 || offsetMinute > 59) {
    fail('SHIPMENT_CONFIRMED_AT_INVALID', 'Shipment confirmed timestamp is invalid');
  }
  const date = new Date(confirmedAt);
  if (Number.isNaN(date.getTime())) fail('SHIPMENT_CONFIRMED_AT_INVALID', 'Shipment confirmed timestamp is invalid');
  const parts = Object.fromEntries(RIYADH_DATE_FORMAT.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function requireApprovedBranch(masterData, branchCode) {
  const branch = masterData.getBranch(branchCode);
  if (!isObject(branch) || branch.code !== branchCode) {
    fail('MASTER_BRANCH_UNKNOWN', 'Shipment branch is not approved');
  }
  return branch.code;
}

function requireApprovedProduct(masterData, productCode) {
  const product = masterData.getProduct(productCode);
  if (!isObject(product) || product.code !== productCode) {
    fail('MASTER_PRODUCT_MISMATCH', 'Shipment product does not match the approved master');
  }
  if (product.uqc !== 'OTH'
      || product.supplyClass !== 'PRIVATE_HEALTHCARE_SERVICE'
      || product.allowedZeroRateReason !== 'VATEX-SA-HEA') {
    fail('MASTER_PRODUCT_CLASSIFICATION_UNSUPPORTED', 'Shipment product classification is unsupported');
  }
  return product;
}

function assertWithinTolerance(left, right, tolerance, code, message) {
  const difference = left - right;
  const absolute = difference < 0n ? -difference : difference;
  if (absolute > tolerance) fail(code, message);
}

function readLineFinancials(bag, tolerance) {
  if (!isObject(bag.financialBreakup)) {
    fail('SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', 'Bag financial breakup is required');
  }
  const breakup = bag.financialBreakup;
  const quantity = validatePositiveInteger(bag.quantity);
  const unitPrice = readMoney(breakup.price_effective, 'SHIPMENT_PRICE_INVALID', 'Shipment price is invalid', { positive: true });
  const promotionDiscount = readMoney(breakup.promotion_effective_discount, 'SHIPMENT_DISCOUNT_INVALID', 'Shipment discount is invalid');
  const couponDiscount = readMoney(breakup.coupon_effective_discount, 'SHIPMENT_DISCOUNT_INVALID', 'Shipment discount is invalid');
  const netAmount = readMoney(breakup.value_of_good, 'SHIPMENT_FINANCIAL_VALUE_INVALID', 'Shipment financial value is invalid');
  const taxRate = readMoney(breakup.gst_tax_percentage, 'SHIPMENT_TAX_RATE_INVALID', 'Shipment tax rate is invalid');
  const taxAmount = readMoney(breakup.gst_fee, 'SHIPMENT_FINANCIAL_VALUE_INVALID', 'Shipment financial value is invalid');
  const paidAmount = readMoney(breakup.amount_paid, 'SHIPMENT_FINANCIAL_VALUE_INVALID', 'Shipment financial value is invalid');
  const hasDeliveryField = breakup.delivery_charge !== undefined;
  const deliveryNet = !hasDeliveryField
    ? 0n
    : readMoney(
      breakup.delivery_charge,
      'SHIPMENT_DELIVERY_VALUE_INVALID',
      'Shipment delivery charge is invalid',
    );
  const hasDeliveryAllocation = deliveryNet !== 0n;
  let productPaidAmount = paidAmount;
  let deliveryPaid = 0n;
  let deliveryTax = 0n;
  if (hasDeliveryAllocation) {
    productPaidAmount = netAmount + taxAmount;
    if (productPaidAmount > paidAmount) {
      fail('SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
    }
    deliveryPaid = paidAmount - productPaidAmount;
    if (deliveryNet > deliveryPaid) {
      fail('SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
    }
    deliveryTax = deliveryPaid - deliveryNet;
  }

  if (bag.prices !== undefined) {
    if (!isObject(bag.prices)) fail('SHIPMENT_PRICES_INVALID', 'Shipment prices are invalid');
    for (const [field, amount] of [
      ['promotion_effective_discount', promotionDiscount],
      ['coupon_effective_discount', couponDiscount],
    ]) {
      if (bag.prices[field] !== undefined) {
        const duplicatedAmount = readMoney(bag.prices[field], 'SHIPMENT_DISCOUNT_INVALID', 'Shipment discount is invalid');
        assertWithinTolerance(amount, duplicatedAmount, tolerance,
          'SHIPMENT_DISCOUNT_CONFLICT', 'Shipment discount fields conflict');
      }
    }
  }

  const grossAmount = unitPrice * BigInt(quantity);
  assertWithinTolerance(grossAmount - promotionDiscount - couponDiscount, netAmount, tolerance,
    'LINE_TOTAL_MISMATCH', 'Shipment line totals do not reconcile');
  if (!hasDeliveryAllocation) {
    assertWithinTolerance(netAmount + taxAmount, paidAmount, tolerance,
      'LINE_TOTAL_MISMATCH', 'Shipment line totals do not reconcile');
  }
  return {
    quantity,
    unitPrice: formatMoney(unitPrice),
    grossAmount: formatMoney(grossAmount),
    promotionDiscount: formatMoney(promotionDiscount),
    couponDiscount: formatMoney(couponDiscount),
    netAmount: formatMoney(netAmount),
    taxRate: formatMoney(taxRate),
    taxAmount: formatMoney(taxAmount),
    paidAmount: formatMoney(productPaidAmount),
    netCents: netAmount,
    taxCents: taxAmount,
    paidCents: productPaidAmount,
    deliveryNetCents: deliveryNet,
    deliveryTaxCents: deliveryTax,
    deliveryPaidCents: deliveryPaid,
  };
}

function readDeliveryCharge(snapshot, preparedLines, tolerance) {
  const allocated = preparedLines.reduce((total, prepared) => ({
    net: total.net + prepared.line.deliveryNetCents,
    tax: total.tax + prepared.line.deliveryTaxCents,
    paid: total.paid + prepared.line.deliveryPaidCents,
  }), { net: 0n, tax: 0n, paid: 0n });
  if (snapshot.deliveryCharge === undefined) {
    if (allocated.net !== 0n || allocated.tax !== 0n || allocated.paid !== 0n) {
      fail('SHIPMENT_DELIVERY_CHARGE_REQUIRED', 'Shipment delivery charge breakup is required');
    }
    return { netCents: 0n, taxCents: 0n, paidCents: 0n };
  }
  if (!isObject(snapshot.deliveryCharge)) {
    fail('SHIPMENT_DELIVERY_CHARGE_REQUIRED', 'Shipment delivery charge breakup is required');
  }
  const delivery = snapshot.deliveryCharge;
  if (delivery.taxCategory !== 'S') {
    fail('SHIPMENT_DELIVERY_TAX_RATE_INVALID', 'Shipment delivery tax category is invalid');
  }
  const taxRate = readMoney(
    delivery.taxRate,
    'SHIPMENT_DELIVERY_TAX_RATE_INVALID',
    'Shipment delivery tax rate is invalid',
  );
  const netCents = readMoney(
    delivery.netAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery charge is invalid',
  );
  const taxCents = readMoney(
    delivery.taxAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery charge is invalid',
  );
  const paidCents = readMoney(
    delivery.paidAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery charge is invalid',
  );
  if (taxRate !== 1500n) {
    fail('SHIPMENT_DELIVERY_TAX_RATE_INVALID', 'Shipment delivery tax rate must be 15.00');
  }
  if (netCents + taxCents !== paidCents) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
  }
  const expectedTax = (netCents * 15n + 50n) / 100n;
  if (expectedTax !== taxCents) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge tax does not reconcile');
  }
  assertWithinTolerance(allocated.net, netCents, tolerance,
    'SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
  assertWithinTolerance(allocated.tax, taxCents, tolerance,
    'SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
  assertWithinTolerance(allocated.paid, paidCents, tolerance,
    'SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
  return { netCents, taxCents, paidCents };
}

function prepareLine({ snapshot, options, documentNumber, supplyDate, productCode, product, line, taxDecision, lineNumber }) {
  const row = {
    COMPANY_CODE: options.companyCode,
    SOURCE_ERP: options.sourceErp,
    SUPPLIER_COUNTRY_CODE_ENGLISH: options.supplierCountryCode,
    COMPANY_ROLE: 'S',
    INVOICE_TYPE: 'Simplified Tax Invoice',
    INVOICE_SUBTYPE: 'Regular Domestic Supply',
    TEMPLATE_CODE: 'SIMPLIFIED IN',
    TRAN_DOC_TYPE: 'IN',
    TRAN_DOC_NO: documentNumber,
    TRAN_LINE_NO: lineNumber,
    ERP_TRANSACTION_REF: `${documentNumber}_${lineNumber}`,
    TRAN_DOC_DATE: supplyDate,
    DATE_OF_SUPPLY: supplyDate,
    TRAN_BRANCH: snapshot.branchCode,
    TRAN_SERVICE_BRANCH: snapshot.branchCode,
    PRODUCT_CODE: productCode,
    TRAN_UQC: product.uqc,
    INV_CURRENCY_CODE: 'SAR',
    VAT_CURRENCY_CODE: 'SAR',
    TRAN_QUANTITY: line.quantity,
    TRAN_UNIT_PRICE: line.unitPrice,
    TRAN_GROSS_AMOUNT: line.grossAmount,
    ...(line.promotionDiscount !== '0.00' ? {
      TRAN_DISC1_REASON_CODE: '95',
      TRAN_DISC1_REASON_TEXT: 'Promotion Discount',
      TRAN_DISC1_AMOUNT: line.promotionDiscount,
    } : {}),
    ...(line.couponDiscount !== '0.00' ? {
      TRAN_DISC2_REASON_CODE: '95',
      TRAN_DISC2_REASON_TEXT: 'Coupon Discount',
      TRAN_DISC2_AMOUNT: line.couponDiscount,
    } : {}),
    TRAN_NET_AMOUNT: line.netAmount,
    TRAN_TAX_CODE_CATEGORY: taxDecision.category,
    TRAN_TAX_RATE: taxDecision.rate,
    TRAN_TAX_AMOUNT: line.taxAmount,
    TRAN_NET_PLUS_TAX: line.paidAmount,
    ...(taxDecision.category === 'Z' ? {
      TRAN_VAT_EXEMPT_REASON_CODE: taxDecision.reasonCode,
      TRAN_VAT_EXEMPT_REASON_TEXT: taxDecision.reasonText,
    } : {}),
    ...(snapshot.taxEligibility.buyerName !== null
      || snapshot.taxEligibility.buyerNationalId !== null ? {
      CUST_NAME_WALKIN: snapshot.taxEligibility.buyerName,
      CUST_ADDITIONAL_ID_NO_WALKIN: snapshot.taxEligibility.buyerNationalId,
      CUST_ADDL_ID_TYP_WALKIN: 'NAT',
    } : {}),
  };
  return { row, line };
}

function buildOeisPayload(snapshot, options) {
  if (!isObject(snapshot)) fail('SHIPMENT_SNAPSHOT_INVALID', 'Shipment snapshot is invalid');
  if (!isObject(options)) fail('PAYLOAD_CONFIG_INVALID', 'OEIS payload configuration is invalid');
  const companyCode = requireNonEmptyString(options.companyCode, 'PAYLOAD_CONFIG_INVALID', 'OEIS company code is required');
  const sourceErp = requireNonEmptyString(options.sourceErp, 'PAYLOAD_CONFIG_INVALID', 'OEIS source ERP is required');
  if (options.supplierCountryCode !== 'SA') fail('PAYLOAD_CONFIG_INVALID', 'OEIS supplier country must be SA');
  const tolerance = readMoney(options.amountTolerance, 'PAYLOAD_CONFIG_INVALID', 'OEIS amount tolerance is invalid');
  if (typeof options.amountTolerance !== 'string' || options.amountTolerance !== '0.01' || tolerance !== 1n) {
    fail('PAYLOAD_CONFIG_INVALID', 'OEIS amount tolerance must be exactly 0.01');
  }
  const masterData = requireMasterData(options.masterData);
  const taxPolicyResolver = requireTaxPolicyResolver(options.taxPolicyResolver);

  const shipmentId = requireNonEmptyString(snapshot.shipmentId, 'SHIPMENT_IDENTIFIER_REQUIRED', 'Shipment identifier is required');
  if (snapshot.currency !== 'SAR') fail('CURRENCY_UNSUPPORTED', 'Shipment currency must be SAR');
  if (!['CARD', 'APPLE_PAY'].includes(snapshot.paymentMode)) {
    fail('PAYMENT_MODE_UNSUPPORTED', 'Shipment payment mode is not supported');
  }
  if (!Array.isArray(snapshot.bags) || snapshot.bags.length === 0) {
    fail('SHIPMENT_BAGS_REQUIRED', 'Shipment bags are required');
  }
  const branchCode = requireNonEmptyString(snapshot.branchCode, 'SHIPMENT_BRANCH_REQUIRED', 'Shipment branch is required');
  requireApprovedBranch(masterData, branchCode);
  if (snapshot.policyVersion !== '2026-08-17') {
    fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy version is invalid');
  }
  const documentNumber = `VR-${shipmentId}-1`;
  const preparedOptions = { companyCode, sourceErp, supplierCountryCode: 'SA', tolerance, masterData };

  const lineInputs = snapshot.bags.map((bag, index) => {
    if (!isObject(bag)) fail('SHIPMENT_BAG_INVALID', 'Shipment bag is invalid');
    const productCode = requireNonEmptyString(bag.productCode, 'SHIPMENT_PRODUCT_REQUIRED', 'Shipment product is required');
    const product = requireApprovedProduct(masterData, productCode);
    const line = readLineFinancials(bag, tolerance);
    return { bag, lineNumber: index + 1, productCode, product, line };
  });
  if (new Set(lineInputs.map(({ line }) => line.taxRate)).size !== 1) {
    fail('TAX_ELIGIBILITY_MIXED_RATES', 'Healthcare order contains mixed product tax rates');
  }
  const resolvedLines = lineInputs.map(input => ({
    ...input,
    taxDecision: taxPolicyResolver.resolveLineTax({
      product: input.product,
      eligibility: snapshot.taxEligibility,
      financialBreakup: {
        netAmount: input.line.netAmount,
        taxRate: input.line.taxRate,
        taxAmount: input.line.taxAmount,
        paidAmount: input.line.paidAmount,
      },
    }),
  }));
  const supplyDate = getRiyadhDate(snapshot.confirmedAt);
  const preparedLines = resolvedLines.map(input => {
    return prepareLine({
      snapshot, options: preparedOptions, documentNumber, supplyDate,
      ...input,
    });
  });
  const deliveryCharge = readDeliveryCharge(snapshot, preparedLines, tolerance);
  const productTotals = preparedLines.reduce((totals, prepared) => ({
    net: totals.net + prepared.line.netCents,
    tax: totals.tax + prepared.line.taxCents,
    paid: totals.paid + prepared.line.paidCents,
  }), { net: 0n, tax: 0n, paid: 0n });
  const invoiceTotals = {
    net: productTotals.net + deliveryCharge.netCents,
    tax: productTotals.tax + deliveryCharge.taxCents,
    paid: productTotals.paid + deliveryCharge.paidCents,
  };
  const shipmentAmountPaid = readMoney(snapshot.amountPaid, 'SHIPMENT_AMOUNT_PAID_INVALID', 'Shipment amount paid is invalid');
  assertWithinTolerance(invoiceTotals.net + invoiceTotals.tax, invoiceTotals.paid, 1n,
    'INVOICE_TOTAL_MISMATCH', 'Shipment invoice totals do not reconcile');
  assertWithinTolerance(invoiceTotals.paid, shipmentAmountPaid, tolerance,
    'INVOICE_TOTAL_MISMATCH', 'Shipment invoice totals do not reconcile');

  const rows = preparedLines.map(({ row }) => ({
    ...row,
    ...(deliveryCharge.paidCents === 0n ? {} : {
      INV_CHGS_TAX_CATEGORY: 'S',
      INV_CHGS_VAT_RATE: '15.00',
      INV_CHGS_VAT_AMOUNT: formatMoney(deliveryCharge.taxCents),
      INV_CHGS_REASON_CODE: 'DL',
      INV_CHGS_REASON_TEXT: 'Delivery',
      INV_CHGS_AMOUNT: formatMoney(deliveryCharge.netCents),
    }),
    INV_NET_AMOUNT: formatMoney(invoiceTotals.net),
    INV_TOTAL_TAX_AMOUNT: formatMoney(invoiceTotals.tax),
    INV_TOTAL_AMOUNT: formatMoney(invoiceTotals.paid),
    INV_CUSTOMER_PAID_AMOUNT: formatMoney(invoiceTotals.paid),
    INV_CUSTOMER_AMOUNT_DUE: '0.00',
    PAY_METHOD: '48',
  }));
  const requestJson = JSON.stringify(rows);
  const requestHash = crypto.createHash('sha256').update(requestJson, 'utf8').digest('hex');
  return { documentNumber, rows, requestJson, requestHash };
}

module.exports = { buildOeisPayload };
