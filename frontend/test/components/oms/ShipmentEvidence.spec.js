import React from 'react';
import { render, screen } from '@testing-library/react';

import { ShipmentEvidence } from '../../../components/oms/ShipmentEvidence';
import { ShipmentJourney } from '../../../components/oms/ShipmentJourney';
import { ShipmentSummary } from '../../../components/oms/ShipmentSummary';
import { dryRunJourney, timelinePage } from './omsFixtures';

test('shows only allowlisted evidence values and keeps normalized JSON collapsed', () => {
  render(<ShipmentEvidence timeline={timelinePage.items} journey={dryRunJourney} />);
  expect(screen.getByText('OEIS_RETRY')).toBeInTheDocument();
  expect(screen.getByText('Attempt 2')).toBeInTheDocument();
  expect(screen.getByText('1 min 0 s')).toBeInTheDocument();
  expect(screen.getAllByText('Next attempt').length).toBeGreaterThan(0);
  const normalized = screen.getByText('Normalized shipment snapshot').closest('details');
  expect(normalized).not.toHaveAttribute('open');
  expect(normalized).not.toHaveTextContent('must not render');
});

test('renders every safe timeline and journey evidence family through fixed fields only', () => {
  const fyndRequest = { kind: 'FYND_REQUEST', operation: 'LOCK', shipmentId: 'shipment-100', documentNumber: 'INV-100', requestedLock: true, requestedStatus: 'locked', privateToken: 'must not render' };
  const oeisRequest = { kind: 'OEIS_REQUEST', documentNumber: 'INV-100', documentType: '388', lineCount: 2, currency: 'AED', netAmount: '10.00', taxAmount: '0.50', totalAmount: '10.50', taxSummaries: [{ category: 'S', rate: '5.00', reasonCode: null, lineCount: 2 }], requestByteCount: 321, requestSha256: 'b'.repeat(64), endpointPath: '/API/V2/Transaction/UpdateInvoiceData', attemptNumber: 2, timeoutMs: 5000, privateToken: 'must not render' };
  const oeisResponse = { kind: 'OEIS_RESPONSE', httpStatus: 200, isSystemException: false, validationResult: 'VALID', reportingStatus: 'REPORTED', clearanceStatus: 'CLEARED', invoiceNumber: 'OEIS-1', transactionNumber: 'TX-1', uuid: 'u-1', invoiceCounter: '3', matchingKey: 'MK-1', validationCodes: ['VALID'], responseByteCount: 100, responseSha256: 'c'.repeat(64), retryable: false, latencyMs: 123, privateToken: 'must not render' };
  const artifact = { kind: 'OEIS_ARTIFACT', signedXmlPresent: true, signedXmlByteCount: 55, signedXmlSha256: 'd'.repeat(64), qrPresent: true, qrByteCount: 12, qrSha256: 'e'.repeat(64), privateToken: 'must not render' };
  const timeline = timelinePage.items.map((item, index) => index === 0 ? { ...item, requestSummary: oeisRequest, responseSummary: oeisResponse } : index === 1 ? { ...item, requestSummary: fyndRequest, responseSummary: artifact } : item);
  render(<ShipmentEvidence timeline={timeline} journey={dryRunJourney} />);
  ['Duration', 'Queue delay', 'Job ID', 'Document number', 'Artifact record ID', 'Started', 'Completed', 'Tax summaries', 'System exception', 'Invoice counter', 'Matching key', 'Response bytes', 'Response SHA-256', 'Signed XML bytes', 'QR bytes', 'Exact Fynd lock request', 'Payload preparation', 'OEIS diagnostic metadata', 'Fynd transition evidence', 'Entity type', 'Action type', 'Reason', 'Transition status', 'Shipment identifier', 'Requested lock'].forEach(label => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  ['shipments', 'lock', 'complete', 'OEIS invoice INV-100', 'bag_invoiced', 'shipment-100', '19 Aug 2026, 09:03:00 UTC'].forEach(value => expect(screen.getAllByText(value).length).toBeGreaterThan(0));
  expect(screen.queryByText('must not render')).not.toBeInTheDocument();
});

test('journey rail follows returned stage evidence and labels absent stages Not reached', () => {
  render(<ShipmentJourney timeline={timelinePage.items} />);
  expect(screen.getByRole('list', { name: 'Shipment journey' })).toHaveTextContent('Webhook');
  expect(screen.getByRole('list', { name: 'Shipment journey' })).toHaveTextContent('Fynd lock');
  expect(screen.getByText('OEIS').closest('li')).toHaveTextContent('Not reached');
  expect(screen.getByText('Artifact').closest('li')).toHaveTextContent('Not reached');
  expect(screen.getByText('Fynd transition').closest('li')).toHaveTextContent('Not reached');
});

test('journey rail selects the latest returned event for a reached stage', () => {
  const laterLock = { ...timelinePage.items[1], action: 'FYND_LOCK_READBACK', occurredAt: '2026-08-19T09:04:00.000Z' };
  render(<ShipmentJourney timeline={[...timelinePage.items, laterLock]} />);
  expect(screen.getByText('Fynd lock').closest('li')).toHaveTextContent('Fynd invoice lock readback');
});

test('summary uses selected shipment identity and the latest timeline update and safe code', () => {
  render(<ShipmentSummary row={{ shipmentId: 'shipment-100', documentNumber: 'INV-100', jobId: 100, outcome: 'SUCCESS', updatedAt: '2026-08-19T08:00:00.000Z', safeCode: 'OLD_CODE' }} timeline={timelinePage.items} />);
  expect(screen.getByText('shipment-100')).toBeInTheDocument();
  expect(screen.getByText('INV-100')).toBeInTheDocument();
  expect(screen.getByText('100')).toBeInTheDocument();
  expect(screen.getByText('OEIS_RETRY')).toBeInTheDocument();
  expect(screen.getByText('19 Aug 2026, 09:02:00 UTC')).toBeInTheDocument();
});
