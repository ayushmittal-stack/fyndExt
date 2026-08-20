import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { OmsWorkspace } from '../../../components/oms/OmsWorkspace';
import { shipmentPage, nextShipmentPage } from './omsFixtures';
import * as dryRunApi from '../../../services/dryRunApi';
import * as shipmentActivityApi from '../../../services/shipmentActivityApi';

jest.mock('../../../services/dryRunApi', () => ({
  getDryRunJourney: jest.fn(), getDryRunPodCurl: jest.fn(), getDryRunRequestBlob: jest.fn(),
  listDryRunFailures: jest.fn(), listDryRuns: jest.fn(),
}));
jest.mock('../../../services/shipmentActivityApi', () => ({
  getShipmentTimeline: jest.fn(), listPreJobFailures: jest.fn(), listShipmentActivity: jest.fn(),
}));

function renderWorkspace() {
  return render(<MemoryRouter initialEntries={['/company/12/application/34']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
    <Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes>
  </MemoryRouter>);
}
function renderStrictWorkspace() {
  return render(<React.StrictMode><MemoryRouter initialEntries={['/company/12/application/34']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
    <Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes>
  </MemoryRouter></React.StrictMode>);
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers(); });

test('loads one bounded Shipments page and does no background OMS work', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  const listenerSpy = jest.spyOn(document, 'addEventListener');
  renderWorkspace();

  expect(screen.getByRole('status')).toHaveTextContent('Loading shipments');
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledWith({ companyId: '12', limit: 20, before: null });
  expect(screen.getByText('Showing 2 of 2 loaded')).toBeInTheDocument();
  expect(screen.getByText('Document unavailable')).toBeInTheDocument();
  [dryRunApi.listDryRuns, dryRunApi.listDryRunFailures, shipmentActivityApi.listPreJobFailures,
    shipmentActivityApi.getShipmentTimeline, dryRunApi.getDryRunJourney].forEach(api => expect(api).not.toHaveBeenCalled());
  expect(listenerSpy.mock.calls.some(([name]) => name === 'visibilitychange')).toBe(false);
});

test('starts exactly one adoptable initial Shipments request under React StrictMode and releases it on settlement', async () => {
  let resolve;
  shipmentActivityApi.listShipmentActivity.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = render(<React.StrictMode><MemoryRouter initialEntries={['/company/12/application/34']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
    <Routes><Route path="/company/:company_id/application/:application_id" element={<OmsWorkspace />} /></Routes>
  </MemoryRouter></React.StrictMode>);
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledWith({ companyId: '12', limit: 20, before: null });
  await act(async () => { resolve(shipmentPage); });
  expect(screen.getByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  first.unmount();
  shipmentActivityApi.listShipmentActivity.mockResolvedValueOnce(shipmentPage);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
});

test('a pending StrictMode bootstrap cannot cross a real same-company remount', async () => {
  const oldRequest = deferred(); const newRequest = deferred();
  const stalePage = { items: [{ ...shipmentPage.items[0], shipmentId: 'stale-remount' }], nextBefore: null };
  shipmentActivityApi.listShipmentActivity
    .mockReturnValueOnce(oldRequest.promise)
    .mockReturnValueOnce(newRequest.promise);
  const first = renderStrictWorkspace();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  first.unmount();

  renderStrictWorkspace();
  const callCountAfterRemount = shipmentActivityApi.listShipmentActivity.mock.calls.length;
  oldRequest.resolve(stalePage);
  newRequest.resolve(shipmentPage);
  await act(async () => Promise.resolve());
  expect(callCountAfterRemount).toBe(2);
  expect(screen.queryByRole('button', { name: /stale-remount/i })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();
});

test('a pending old-mount bootstrap 401 cannot terminate a new same-company mount', async () => {
  const oldRequest = deferred(); const newRequest = deferred();
  shipmentActivityApi.listShipmentActivity
    .mockReturnValueOnce(oldRequest.promise)
    .mockReturnValueOnce(newRequest.promise);
  const first = renderStrictWorkspace();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  first.unmount();

  renderStrictWorkspace();
  const callCountAfterRemount = shipmentActivityApi.listShipmentActivity.mock.calls.length;
  oldRequest.reject(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  newRequest.resolve(shipmentPage);
  await act(async () => Promise.resolve());
  expect(callCountAfterRemount).toBe(2);
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /shipment-100.*success/i })).toBeInTheDocument();
});

test('schedules neither intervals nor timeouts for the routed Shipment queue', async () => {
  jest.useFakeTimers();
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  renderWorkspace();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(jest.getTimerCount()).toBe(0);
});

test('refresh replaces a verified page and retains it on a transient failure', async () => {
  shipmentActivityApi.listShipmentActivity
    .mockResolvedValueOnce(shipmentPage)
    .mockResolvedValueOnce({ items: [nextShipmentPage.items[1]], nextBefore: 'cursor-refreshed' })
    .mockRejectedValueOnce(Object.assign(new Error('failed'), { kind: 'request-failed' }))
    .mockResolvedValueOnce(nextShipmentPage);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  await screen.findByRole('button', { name: /shipment-98.*success/i });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, before: null });
  const refreshedAt = screen.getByText(/Last refreshed/).textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Shipment refresh failed');
  expect(screen.getByText('Shipment refresh failed').closest('[role="status"]')).toHaveTextContent('last loaded data');
  expect(screen.getByText(/Last refreshed/).textContent).toBe(refreshedAt);
  expect(screen.getByRole('button', { name: /shipment-98.*success/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, before: 'cursor-refreshed' });
});

test('clears failed-request feedback after a retry succeeds and suppresses refresh double clicks', async () => {
  let resolve;
  shipmentActivityApi.listShipmentActivity
    .mockRejectedValueOnce(Object.assign(new Error('failed'), { kind: 'request-failed' }))
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  renderWorkspace();
  await screen.findByText('Could not load shipments');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refreshing…' }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(shipmentPage); });
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(screen.queryByText(/last loaded data/i)).not.toBeInTheDocument();
});

test('loads one opaque cursor page, deduplicates it, and keeps its cursor after failure', async () => {
  shipmentActivityApi.listShipmentActivity
    .mockResolvedValueOnce(shipmentPage)
    .mockRejectedValueOnce(Object.assign(new Error('failed'), { kind: 'request-failed' }))
    .mockResolvedValueOnce(nextShipmentPage);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Could not load more shipments');
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenLastCalledWith({ companyId: '12', limit: 20, before: 'cursor-99' });
  expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('button', { name: /shipment-98.*success/i });
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /shipment-99.*timeout/i })).toHaveLength(1);
});

test('filters loaded rows in place and resets without requesting again', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.change(screen.getByLabelText('Search loaded shipments'), { target: { value: 'timeout' } });
  expect(screen.getByText('Showing 1 of 2 loaded')).toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByText('Showing 2 of 2 loaded')).toBeInTheDocument();
});

test('uses all loaded stage and outcome values as filter choices', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValue(shipmentPage);
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  expect(screen.getByRole('option', { name: 'Fynd invoice lock' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'OEIS submission' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Timeout' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'FYND_LOCK' } });
  fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'TIMEOUT' } });
  expect(screen.getByText('Showing 1 of 2 loaded')).toBeInTheDocument();
});

test('clears a selected stage/outcome filter when Refresh replaces its loaded vocabulary', async () => {
  shipmentActivityApi.listShipmentActivity
    .mockResolvedValueOnce(shipmentPage)
    .mockResolvedValueOnce({ items: [nextShipmentPage.items[1]], nextBefore: null });
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'FYND_LOCK' } });
  fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'TIMEOUT' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('button', { name: /shipment-98.*success/i });
  expect(screen.getByLabelText('Stage')).toHaveValue('');
  expect(screen.getByLabelText('Outcome')).toHaveValue('');
  expect(screen.getByText('Showing 1 of 1 loaded')).toBeInTheDocument();
});

test('renders distinct initial empty and initial request-failed states', async () => {
  shipmentActivityApi.listShipmentActivity.mockResolvedValueOnce({ items: [], nextBefore: null });
  renderWorkspace();
  expect(await screen.findByText('No shipments loaded')).toBeInTheDocument();

  shipmentActivityApi.listShipmentActivity.mockRejectedValueOnce(Object.assign(new Error('failed'), { kind: 'request-failed' }));
  renderWorkspace();
  expect(await screen.findByText('Could not load shipments')).toBeInTheDocument();
  expect(screen.queryByText(/last loaded data/i)).not.toBeInTheDocument();
});

test('renders a terminal alert for an initial 401', async () => {
  shipmentActivityApi.listShipmentActivity.mockRejectedValueOnce(Object.assign(new Error('expired'), { kind: 'unauthorized' }));
  renderWorkspace();
  expect(await screen.findByRole('alert')).toHaveTextContent('Session expired');
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
});

test('ignores a deferred response after unmount', async () => {
  let resolve;
  shipmentActivityApi.listShipmentActivity.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { unmount } = renderWorkspace();
  unmount();
  await act(async () => { resolve(shipmentPage); });
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
});

test('restarts an interrupted unverified Shipment load after moving away and back', async () => {
  let resolveStale;
  shipmentActivityApi.listShipmentActivity
    .mockImplementationOnce(() => new Promise(done => { resolveStale = done; }))
    .mockResolvedValueOnce(nextShipmentPage);
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
  await screen.findByRole('button', { name: /shipment-98.*success/i });
  await act(async () => { resolveStale(shipmentPage); });
  expect(screen.queryByRole('button', { name: /shipment-100.*success/i })).not.toBeInTheDocument();
});

test('ignores a deferred shipment 401 after moving away and back', async () => {
  let reject;
  shipmentActivityApi.listShipmentActivity.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  renderWorkspace();
  fireEvent.click(screen.getByRole('tab', { name: /Failures/ }));
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  await act(async () => { reject(Object.assign(new Error('expired'), { kind: 'unauthorized' })); });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
});

test('does not refresh Shipments from an inactive placeholder tab and retains an active cursor on double clicks', async () => {
  let resolve;
  shipmentActivityApi.listShipmentActivity
    .mockResolvedValueOnce(shipmentPage)
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  renderWorkspace();
  await screen.findByRole('button', { name: /shipment-100.*success/i });
  fireEvent.click(screen.getByRole('tab', { name: /Held/ }));
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: /Shipments/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  fireEvent.click(screen.getByRole('button', { name: 'Loading more…' }));
  expect(shipmentActivityApi.listShipmentActivity).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(nextShipmentPage); });
});
