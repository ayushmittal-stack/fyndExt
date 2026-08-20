import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { dryRunJourney, heldPage, nextHeldPage, shipmentPage, timelinePage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({ getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(), listDryRunFailures: jest.fn(), listDryRuns: jest.fn() }));
jest.mock('../../../services/shipmentActivityApi', () => ({ getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn() }));

function renderWorkspace() {
  return render(<MemoryRouter initialEntries={['/company/12/application/34']}><Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  dryRunApi.listDryRuns.mockResolvedValue(heldPage);
  shipmentActivityApi.getShipmentTimeline.mockResolvedValue(timelinePage);
  dryRunApi.getDryRunJourney.mockResolvedValue(dryRunJourney);
});
afterEach(() => { jest.resetAllMocks(); });

test('fetches one bounded Held page only on activation and caches it until Refresh', async () => {
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(dryRunApi.listDryRuns).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  expect(await screen.findByRole('button', { name: /shipment-100.*held/i })).toBeInTheDocument();
  expect(dryRunApi.listDryRuns).toHaveBeenCalledWith({ companyId: '12', limit: 20, beforeId: null });
  expect(dryRunApi.listDryRuns).toHaveBeenCalledTimes(1);
  expect(dryRunApi.listDryRunFailures).not.toHaveBeenCalled();
  expect(shipmentActivityApi.listPreJobFailures).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  expect(dryRunApi.listDryRuns).toHaveBeenCalledTimes(1);
});

test('paginates Held with its numeric cursor, deduplicates overlap, and retries the same failed cursor', async () => {
  dryRunApi.listDryRuns
    .mockResolvedValueOnce(heldPage)
    .mockRejectedValueOnce(Object.assign(new Error('private'), { kind: 'request-failed' }))
    .mockResolvedValueOnce(nextHeldPage);
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  await screen.findByRole('button', { name: /shipment-100.*held/i });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Could not load more held shipments')).toBeInTheDocument();
  expect(dryRunApi.listDryRuns).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, beforeId: 99 });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('button', { name: /held-98.*held/i })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /held-99.*held/i })).toHaveLength(1);
  expect(dryRunApi.listDryRuns).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, beforeId: 99 });
});

test('manual Held Refresh replaces the first page and retains verified rows after failure', async () => {
  dryRunApi.listDryRuns
    .mockResolvedValueOnce(heldPage)
    .mockResolvedValueOnce({ items: [nextHeldPage.items[1]], nextBeforeId: null })
    .mockRejectedValueOnce(Object.assign(new Error('private'), { kind: 'request-failed' }));
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  await screen.findByRole('button', { name: /shipment-100.*held/i });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(dryRunApi.listDryRuns).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, beforeId: null });
  expect(await screen.findByRole('button', { name: /held-98.*held/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /shipment-100.*held/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Held refresh failed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /held-98.*held/i })).toBeInTheDocument();
});

test('Held opens the shared detail identity and Back returns to the cached Held queue', async () => {
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  fireEvent.click(await screen.findByRole('button', { name: /shipment-100.*held/i }));
  expect(await screen.findByRole('heading', { name: 'shipment-100', level: 1 })).toBeInTheDocument();
  expect(shipmentActivityApi.getShipmentTimeline).toHaveBeenCalledWith({ companyId: '12', shipmentId: 'shipment-100', limit: 50, before: null });
  expect(dryRunApi.getDryRunJourney).toHaveBeenCalledWith({ companyId: '12', jobId: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Held' }));
  expect(screen.getByRole('button', { name: /shipment-100.*held/i })).toBeInTheDocument();
  expect(dryRunApi.listDryRuns).toHaveBeenCalledTimes(1);
});

test('ignores a delayed Held success after changing queues', async () => {
  let resolve;
  dryRunApi.listDryRuns.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  await waitFor(() => expect(dryRunApi.listDryRuns).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('tab', { name: /Failures/ }));
  await act(async () => { resolve(heldPage); });
  expect(screen.queryByRole('button', { name: /shipment-100.*held/i })).not.toBeInTheDocument();
});

test('ignores a delayed Held 401 after changing queues', async () => {
  let reject;
  dryRunApi.listDryRuns.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  await waitFor(() => expect(dryRunApi.listDryRuns).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  await act(async () => { reject(Object.assign(new Error('expired'), { kind: 'unauthorized' })); });
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
});
