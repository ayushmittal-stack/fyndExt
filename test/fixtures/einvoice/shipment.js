'use strict';

function makeShipmentWebhook(overrides = {}) {
  const shipment = {
    shipment_id: '17861361389811907489',
    shipment_status: {
      status: 'bag_confirmed',
      status_created_at: '2026-08-10T06:30:00.000Z',
      created_ts: '2026-08-10T06:30:00.000Z',
    },
    fulfilling_store: { code: 'BRANCH-01' },
    currency: 'SAR',
    amount_paid: '115.00',
    payment_info: [{ mode: 'CARD' }],
    order: {
      meta: {
        custom_cart_meta: {
          custom_conditions: {
            taxation_nationality: false,
            recipient_name: 'Synthetic Standard Buyer',
            national_id: '1999999999',
          },
        },
      },
    },
    bags: [{
      bag_id: 'bag-1',
      seller_identifier: 'SKU-01',
      item: { attributes: { 'product-type': 'service' } },
      quantity: 1,
      financial_breakup: {
        price_effective: '100.00',
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
  };

  return {
    event: { id: 'evt-1' },
    company_id: 12655,
    application_id: 'app-1',
    payload: { shipment: { ...shipment, ...overrides } },
  };
}

function makeLiveNestedShipmentWebhook() {
  return {
    event: { id: 'evt-live-safe-1' },
    company_id: 12655,
    application_id: 'app-1',
    payload: {
      shipment: {
        shipment_id: '17861361389811907490',
        shipment_status: {
          status: 'bag_confirmed',
          status_created_at: '2026-08-18T12:00:00.000Z',
          created_ts: '2026-08-18T06:30:00.000Z',
        },
        fulfilling_store: { code: 'BRANCH-01' },
        currency: { currency_code: 'SAR' },
        payment_info: [{ mode: 'CARD' }],
        payment_methods: { card: { mode: 'CARD' } },
        prices: { amount_paid: '38.38' },
        order: {
          currency: { currency_code: 'SAR' },
          payment_info: [{ mode: 'CARD' }],
          payment_methods: { card: { mode: 'CARD' } },
          prices: { amount_paid: '38.38' },
          meta: {
            currency: { currency_code: 'SAR' },
            custom_cart_meta: {
              custom_conditions: { taxation_nationality: false },
            },
          },
        },
        bags: [{
          bag_id: 'bag-live-safe-1',
          seller_identifier: 'SKU-LIVE-01',
          item: { attributes: { 'product-type': 'service' } },
          article: {
            seller_identifier: 'SKU-LIVE-01',
            identifiers: { sku_code: 'SKU-LIVE-01' },
          },
          quantity: 1,
          prices: {
            price_effective: '33.37',
            promotion_effective_discount: '0.00',
            coupon_effective_discount: '0.00',
            value_of_good: '33.37',
            amount_paid: '38.38',
          },
          financial_breakup: [{
            identifiers: { sku_code: 'SKU-LIVE-01' },
            gst_tax_percentage: '15.00',
            gst_fee: '5.01',
          }],
        }],
      },
    },
  };
}

module.exports = { makeLiveNestedShipmentWebhook, makeShipmentWebhook };
