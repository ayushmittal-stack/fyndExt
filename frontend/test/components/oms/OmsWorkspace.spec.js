import React from 'react';
import { render, screen } from '@testing-library/react';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({
  getDryRunJourney: jest.fn(),
  getDryRunPodCurl: jest.fn(),
  getDryRunRequestBlob: jest.fn(),
  listDryRunFailures: jest.fn(),
  listDryRuns: jest.fn(),
}));

jest.mock('../../../services/shipmentActivityApi', () => ({
  getShipmentTimeline: jest.fn(),
  listPreJobFailures: jest.fn(),
  listShipmentActivity: jest.fn(),
}));

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

test('renders the static Phase 1 OMS shell without operational actions', () => {
  render(<OmsWorkspace />);

  expect(screen.getByRole('heading', { name: 'E-Invoicing Shipments' })).toBeInTheDocument();
  expect(screen.getByText('Shipment operations, arranged like Fynd OMS.')).toBeInTheDocument();
  expect(screen.getByText('Shipment workspace')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
});

test('starts no operational work while the static shell is mounted', () => {
  const intervalSpy = jest.spyOn(global, 'setInterval');
  const timeoutSpy = jest.spyOn(global, 'setTimeout');
  const documentListenerSpy = jest.spyOn(document, 'addEventListener');

  render(<OmsWorkspace />);

  [
    dryRunApi.getDryRunJourney,
    dryRunApi.getDryRunPodCurl,
    dryRunApi.getDryRunRequestBlob,
    dryRunApi.listDryRunFailures,
    dryRunApi.listDryRuns,
  ].forEach(apiFunction => {
    expect(apiFunction).not.toHaveBeenCalled();
  });
  [
    shipmentActivityApi.getShipmentTimeline,
    shipmentActivityApi.listPreJobFailures,
    shipmentActivityApi.listShipmentActivity,
  ].forEach(apiFunction => {
    expect(apiFunction).not.toHaveBeenCalled();
  });
  expect(intervalSpy).not.toHaveBeenCalled();
  expect(timeoutSpy).not.toHaveBeenCalled();
  expect(documentListenerSpy.mock.calls.some(([eventName]) => eventName === 'visibilitychange'))
    .toBe(false);
});
