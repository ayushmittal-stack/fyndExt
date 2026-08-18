'use strict';

const SHIPMENT_ID = '17861361389811907489';
const DOCUMENT_NUMBER = 'VR-17861361389811907489-1';
const SIGNED_XML = '<ubl:Invoice><cbc:ID>VR-17861361389811907489-1</cbc:ID></ubl:Invoice>';
const SIGNED_XML_BASE64 = 'PHVibDpJbnZvaWNlPjxjYmM6SUQ+VlItMTc4NjEzNjEzODk4MTE5MDc0ODktMTwvY2JjOklEPjwvdWJsOkludm9pY2U+';

function transitionResult(overrides = {}) {
  return {
    identifier: SHIPMENT_ID,
    status: 200,
    final_state: {
      shipment_id: SHIPMENT_ID,
      bag_invoiced: 'bag_invoiced',
    },
    ...overrides,
  };
}

function nestedTransitionSuccess(overrides = {}) {
  return {
    statuses: [{
      status: 'bag_invoiced',
      shipments: [transitionResult(overrides)],
    }],
  };
}

function flatTransitionSuccess(overrides = {}) {
  return { statuses: [transitionResult(overrides)] };
}

function readShipment(overrides = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shipment_status: 'bag_invoiced',
    status: { status: 'bag_dispatch', current_shipment_status: 'bag_invoiced' },
    lock_status: false,
    lock_details: { lock_status: true },
    invoice: { store_invoice_id: DOCUMENT_NUMBER },
    gst_details: { store_invoice_id: 'legacy-invoice-id' },
    meta: { einvoice_info: { SignedQRCode: SIGNED_XML_BASE64 } },
    custom_meta: [{ customer_internal_note: 'Customer Name' }],
    user: { name: 'Customer Name', phone: '+966500000000' },
    payment_info: [{ mode: 'CARD', card_number: '4111111111111111' }],
    bags: [{ bag_id: 'bag-1', customer: { email: 'customer@example.test' } }],
    ...overrides,
  };
}

module.exports = {
  DOCUMENT_NUMBER,
  SHIPMENT_ID,
  SIGNED_XML,
  SIGNED_XML_BASE64,
  flatTransitionSuccess,
  nestedTransitionSuccess,
  readShipment,
  transitionResult,
};
